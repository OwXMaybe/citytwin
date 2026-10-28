import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { maplibregl } from './maplibre';
import type { ExpressionSpecification, GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useCity } from '../../hooks/CityDataContext';
import { pointInRing, ringAreaM2 } from '../../lib/geo';
import { hashCoord, seeded } from '../../lib/random';
import { interpolateAir } from '../../services/analysis';
import { osmIdFromTileId, USE_CATEGORIES, type BuildingRecord } from '../../services/osm/buildings';
import { roadCongestion } from '../../services/simulated';
import { useAppStore, type ColumnMetric, type LayerId } from '../../store/useAppStore';
import { useOsmStore } from '../../store/useOsmStore';
import { buildStyle, FONT, HEIGHT_COLOR_2D, HEIGHT_COLOR_3D, OMT, useColorExpr } from './mapStyle';
import { MapToolbar } from './MapToolbar';
import { DetailLayer, type TreePoint } from './threeDetailLayer';
import { t } from '../../i18n';

type FC = GeoJSON.FeatureCollection;
const EMPTY: FC = { type: 'FeatureCollection', features: [] };

/** Map layer ids controlled by each user-facing layer toggle. */
const LAYER_GROUPS: Record<LayerId, string[]> = {
  buildings: ['bld-3d', 'bld-2d'],
  traffic: ['traffic-casing', 'traffic-line', 'traffic-live-casing', 'traffic-live'],
  stations: ['stations-halo', 'stations-circle', 'stations-label'],
  air: ['air-zone-fill', 'air-heat', 'air-points', 'air-labels'],
  energy: ['energy-fill'],
  zones: ['zones-outline', 'zones-label'],
  green: ['green-park', 'green-landcover'],
  transit: ['transit-rail'],
  incidents: ['incidents-halo', 'incidents-circle'],
  // Rendered by the Three.js detail layer, toggled via DetailLayer.setVisibility.
  vegetation: [],
  columns: [],
};

const TRAFFIC_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor'];

/** Gives floating panels rendered inside CityMap access to the live map instance. */
const MapInstanceContext = createContext<RefObject<maplibregl.Map | null>>({ current: null });
export const useMapInstance = () => useContext(MapInstanceContext);

export interface CityMapProps {
  /** Compact, non-selecting map for dashboards. */
  mini?: boolean;
  /** Layer overrides for the mini variant. */
  miniLayers?: Partial<Record<LayerId, boolean>>;
  children?: ReactNode;
}

export function CityMap({ mini = false, miniLayers, children }: CityMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [tileError, setTileError] = useState<string | null>(null);
  const [trafficBusy, setTrafficBusy] = useState(false);

  const { city, zones, airGrid, incidents, congestionNow, liveTraffic, stations } = useCity();
  const liveSegments = liveTraffic.data?.segments ?? null;
  const storeLayers = useAppStore((s) => s.layers);
  const mapMode = useAppStore((s) => s.mapMode);
  const selection = useAppStore((s) => s.selection);
  const flyTarget = useAppStore((s) => s.flyTarget);
  const select = useAppStore((s) => s.select);
  const showSim = useAppStore((s) => s.settings.showSimulated);
  const visibleIncidents = useMemo(() => incidents.filter((i) => i.live || showSim), [incidents, showSim]);

  const layers = useMemo(
    () => (mini ? { ...storeLayers, traffic: false, incidents: false, energy: false, ...miniLayers } : storeLayers),
    [mini, storeLayers, miniLayers],
  );
  const congestionRef = useRef(congestionNow);
  congestionRef.current = congestionNow;
  const trafficOnRef = useRef(layers.traffic && showSim);
  // Simulated per-road colouring is replaced when the city has real segment data.
  trafficOnRef.current = layers.traffic && showSim && !liveSegments;

  const detailRef = useRef<DetailLayer | null>(null);
  const osmTrees = useOsmStore((s) => s.trees);
  const osmBuildings = useOsmStore((s) => s.buildings);
  const osmVersion = useOsmStore((s) => s.version);
  const colorMode = useOsmStore((s) => s.colorMode);
  const columnMetric = useAppStore((s) => s.columnMetric);
  const vegetationRef = useRef({ on: layers.vegetation, mapped: osmTrees, refresh: () => {} });
  vegetationRef.current.on = layers.vegetation;
  vegetationRef.current.mapped = osmTrees;
  const buildingsRef = useRef(osmBuildings);
  buildingsRef.current = osmBuildings;
  /** Tile feature ids already given a `use` feature-state (avoids idle → repaint loops). */
  const styledTilesRef = useRef(new Set<number>());

  // ---------------------------------------------------------------- init
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildStyle(),
      center: [city.lon, city.lat],
      zoom: mini ? city.zoom - 2.2 : city.zoom,
      pitch: mapMode === '3d' && !mini ? 55 : mini ? 30 : 0,
      bearing: mini ? 0 : -17,
      maxPitch: 75,
      attributionControl: { compact: true },
      interactive: true,
    });
    mapRef.current = map;
    if (import.meta.env.DEV && !mini) (window as unknown as { __cityMap: unknown }).__cityMap = map;
    if (!mini) {
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
      map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    }

    // Tile/network errors surface as a banner until a later view renders cleanly.
    let errored = false;
    map.on('error', (e) => {
      console.warn('[CityMap]', (e.error as Error | undefined)?.message ?? e);
      errored = true;
      setTileError('Some map data failed to load. Check your connection — the map retries as you move.');
    });
    map.on('movestart', () => {
      errored = false;
    });
    map.on('idle', () => {
      if (!errored) setTileError(null);
    });

    map.on('load', () => {
      addOverlays(map);
      if (!mini) {
        const detail = new DetailLayer();
        detail.setOrigin(city.lon, city.lat);
        map.addLayer(detail);
        detailRef.current = detail;
      }
      setReady(true);
    });

    // Vegetation: OSM-mapped trees + illustrative fill sampled inside park polygons in view.
    let lastVegKey = '';
    const refreshVegetation = (force = false) => {
      const detail = detailRef.current;
      if (!detail || !vegetationRef.current.on) return;
      if (map.getZoom() < 14) return detail.setTrees([]);
      const key = `${map.getBounds().toArray().flat().map((n) => n.toFixed(3)).join(',')}`;
      if (key === lastVegKey && !force) return;
      lastVegKey = key;
      const b = map.getBounds();
      const inView = (p: [number, number]) => p[0] >= b.getWest() && p[0] <= b.getEast() && p[1] >= b.getSouth() && p[1] <= b.getNorth();
      const mapped = vegetationRef.current.mapped.filter(inView).map((p, i) => ({ lon: p[0], lat: p[1], mapped: true, seed: ((i * 2654435761) % 1000) / 1000 }));
      detail.setTrees([...mapped, ...sampleParkTrees(map, 6000 - mapped.length)]);
    };
    vegetationRef.current.refresh = () => refreshVegetation(true);
    map.on('idle', () => refreshVegetation());
    // Newly loaded tiles need the imported building attributes applied too.
    map.on('idle', () => applyBuildingState(map, buildingsRef.current, styledTilesRef.current));

    // Traffic overlay derived from rendered road geometry (see computeTraffic).
    let lastKey = '';
    map.on('idle', () => {
      if (!trafficOnRef.current || map.getZoom() < 11.5) return;
      const key = `${map.getBounds().toArray().flat().map((n) => n.toFixed(4)).join(',')}|${map.getZoom().toFixed(2)}`;
      const src = map.getSource('traffic') as GeoJSONSource | undefined;
      if (key === lastKey || !src) return;
      lastKey = key;
      setTrafficBusy(true);
      src.setData(computeTraffic(map, congestionRef.current));
      setTrafficBusy(false);
    });

    if (!mini) {
      const interactive = ['stations-circle', 'incidents-circle', 'traffic-live', 'traffic-line', 'bld-3d', 'bld-2d', 'zones-hit'];
      const visibleInteractive = () => interactive.filter((l) => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
      map.on('mousemove', (e) => {
        if (!map.isStyleLoaded()) return;
        const hit = map.queryRenderedFeatures(e.point, { layers: visibleInteractive() });
        map.getCanvas().style.cursor = hit.length ? 'pointer' : '';
      });
      map.on('click', (e) => {
        // Small tolerance box; pick by layer priority (roads sit under extruded buildings).
        const p = e.point;
        const hits = map.queryRenderedFeatures([[p.x - 4, p.y - 4], [p.x + 4, p.y + 4]], { layers: visibleInteractive() });
        const f = interactive.map((l) => hits.find((h) => h.layer.id === l)).find(Boolean);
        if (!f) return select(null);
        handleClick(f, e.lngLat, select);
      });
    }

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // Map is created once per mount; later changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mini]);

  // ---------------------------------------------------------------- city change
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    detailRef.current?.setOrigin(city.lon, city.lat);
    map.flyTo({ center: [city.lon, city.lat], zoom: mini ? city.zoom - 2.2 : city.zoom, duration: 1800, essential: true });
  }, [city.id, city.lat, city.lon, city.zoom, mini]);

  // ---------------------------------------------------------------- fly target (search)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTarget || mini) return;
    if (flyTarget.bbox) {
      map.fitBounds(flyTarget.bbox, { padding: 80, maxZoom: 16.5, duration: 1600 });
    } else {
      map.flyTo({
        center: [flyTarget.lon, flyTarget.lat],
        zoom: flyTarget.zoom ?? 15.5,
        pitch: flyTarget.pitch ?? map.getPitch(),
        bearing: flyTarget.bearing ?? map.getBearing(),
        duration: 1600,
      });
    }
  }, [flyTarget, mini]);

  // ---------------------------------------------------------------- 2D / 3D
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || mini) return;
    map.easeTo({ pitch: mapMode === '3d' ? 55 : 0, bearing: mapMode === '3d' ? map.getBearing() || -17 : 0, duration: 900 });
  }, [mapMode, ready, mini]);

  // ---------------------------------------------------------------- layer visibility
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const set = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    const simOk = (l: LayerId) => showSim || !['traffic', 'energy'].includes(l) || (l === 'traffic' && !!liveSegments);
    (Object.keys(LAYER_GROUPS) as LayerId[]).forEach((l) => {
      LAYER_GROUPS[l].forEach((id) => set(id, layers[l] && simOk(l)));
    });
    const threeD = mini ? true : mapMode === '3d';
    set('bld-3d', layers.buildings && threeD);
    set('bld-2d', layers.buildings && !threeD);
    set('selected-3d', threeD);
    set('selected-fill', !threeD);
    if (layers.traffic && showSim) {
      (map.getSource('traffic') as GeoJSONSource | undefined)?.setData(computeTraffic(map, congestionRef.current));
    }
    const columnsSimulated = columnMetric === 'energy' || columnMetric === 'traffic';
    detailRef.current?.setVisibility({
      vegetation: layers.vegetation,
      columns: layers.columns && (showSim || !columnsSimulated),
      pulses: layers.incidents && showSim,
    });
    if (layers.vegetation) vegetationRef.current.refresh();
  }, [layers, mapMode, ready, showSim, mini, columnMetric]);

  // ---------------------------------------------------------------- Three.js data
  useEffect(() => {
    const detail = detailRef.current;
    if (!detail || !ready) return;
    const air = airGrid.data ? interpolateAir(zones, airGrid.data) : {};
    const value = (z: (typeof zones)[number]) =>
      columnMetric === 'population' ? z.population
        : columnMetric === 'energy' ? z.energyMWh
        : columnMetric === 'traffic' ? z.trafficIndex
        : (air[z.id]?.pm25 ?? 0);
    const max = Math.max(...zones.map(value), 1e-6);
    detail.setColumns(zones.map((z) => ({ lon: z.center[0], lat: z.center[1], heightM: (value(z) / max) * 1800, color: COLUMN_COLORS[columnMetric] })));
  }, [zones, airGrid.data, columnMetric, ready]);

  useEffect(() => {
    if (!ready) return;
    detailRef.current?.setPulses(visibleIncidents.map((i) => ({ lon: i.lon, lat: i.lat, color: i.kind === 'closure' ? '#ef4444' : '#f97316' })));
  }, [visibleIncidents, ready]);

  useEffect(() => {
    if (ready) vegetationRef.current.refresh();
  }, [osmTrees, ready]);

  // ---------------------------------------------------------------- building attributes (feature-state)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.removeFeatureState({ source: OMT, sourceLayer: 'building' });
    styledTilesRef.current = new Set();
    applyBuildingState(map, osmBuildings, styledTilesRef.current);
    const byUse = colorMode === 'use';
    map.setPaintProperty('bld-3d', 'fill-extrusion-color', byUse ? useColorExpr(USE_CATEGORIES.map((c) => c.color)) : HEIGHT_COLOR_3D);
    map.setPaintProperty('bld-2d', 'fill-color', byUse ? useColorExpr(USE_CATEGORIES.map((c) => c.color)) : HEIGHT_COLOR_2D);
    // osmVersion is the change signal for the (mutable-by-replacement) buildings map.
  }, [osmBuildings, osmVersion, colorMode, ready]);

  // ---------------------------------------------------------------- data → sources
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const air = airGrid.data ? interpolateAir(zones, airGrid.data) : {};
    const fc: FC = {
      type: 'FeatureCollection',
      features: zones.map((z) => ({
        type: 'Feature',
        id: z.id,
        geometry: z.geometry,
        properties: {
          id: z.id,
          name: z.name,
          traffic: z.trafficIndex,
          energy: z.energyMWh,
          energyRatio: z.energyMWh / z.energyBaselineMWh,
          pm25: air[z.id]?.pm25 ?? -1,
          aqi: air[z.id]?.aqi ?? -1,
        },
      })),
    };
    (map.getSource('zones') as GeoJSONSource).setData(fc);
    (map.getSource('zone-centers') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: zones.map((z) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: z.center }, properties: { name: z.name } })),
    });
  }, [zones, airGrid.data, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('air') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: (airGrid.data ?? []).map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { pm25: p.pm25 ?? 0, aqi: p.aqi ?? 0, label: p.pm25 != null ? p.pm25.toFixed(1) : '—' },
      })),
    });
  }, [airGrid.data, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('incidents') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: visibleIncidents.map((i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [i.lon, i.lat] }, properties: { id: i.id, kind: i.kind, title: i.title, live: i.live } })),
    });
  }, [visibleIncidents, ready]);

  // ---------------------------------------------------------------- Phase 3 live data
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('traffic-live') as GeoJSONSource).setData(liveSegments ?? EMPTY);
    // Clear the simulated overlay when real segments take over.
    if (liveSegments) (map.getSource('traffic') as GeoJSONSource).setData(EMPTY);
  }, [liveSegments, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('stations') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: (stations.data?.stations ?? []).map((s) => {
        const pm = s.values.pm25 ?? (s.values.pm10 != null ? s.values.pm10 / 2 : null); // PM10/2 ≈ PM2.5-equivalent band
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
          properties: {
            id: s.id,
            ref: s.grade === 'reference',
            pm: pm ?? -1,
            label: s.values.pm25 != null ? `PM2.5 ${s.values.pm25.toFixed(0)}` : s.values.pm10 != null ? `PM10 ${s.values.pm10.toFixed(0)}` : s.name,
          },
        };
      }),
    });
  }, [stations.data, ready]);

  // ---------------------------------------------------------------- selection highlight
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('selected') as GeoJSONSource;
    const geom = (selection && 'props' in selection ? (selection.props.__geometry as GeoJSON.Geometry | undefined) : undefined) ?? null;
    if (selection?.kind === 'zone') {
      const z = zones.find((x) => x.id === selection.zoneId);
      src.setData(z ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: z.geometry, properties: { kind: 'zone', h: 0, b: 0 } }] } : EMPTY);
    } else if (selection?.kind === 'place') {
      src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [selection.lon, selection.lat] }, properties: { kind: 'place' } }] });
    } else if (geom && selection && 'props' in selection) {
      src.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: geom, properties: { kind: selection.kind, h: Number(selection.props.render_height ?? 0), b: Number(selection.props.render_min_height ?? 0) } }],
      });
    } else {
      src.setData(EMPTY);
    }
  }, [selection, zones, ready]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-ink-950">
      {/* maplibre's unlayered CSS forces position:relative, so size by h/w rather than inset. */}
      <div ref={containerRef} className="h-full w-full" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-ink-300">
          <Loader2 className="size-4 animate-spin text-accent" /> {t('Loading city model…')}
        </div>
      )}
      {tileError && (
        <div className="absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded border border-amber-500/40 bg-ink-900/95 px-3 py-1.5 text-xs text-amber-300">
          <AlertTriangle className="size-3.5" /> {tileError}
        </div>
      )}
      {!mini && <MapToolbar trafficBusy={trafficBusy} />}
      <MapInstanceContext.Provider value={mapRef}>{children}</MapInstanceContext.Provider>
    </div>
  );
}

// ==================================================================== helpers

const USE_INDEX = new Map(USE_CATEGORIES.map((c, i) => [c.id, i]));

/** Sets feature-state `use` on loaded vector-tile buildings that have imported OSM attributes. */
function applyBuildingState(map: maplibregl.Map, records: Map<number, BuildingRecord>, styled: Set<number>) {
  if (!records.size || !map.getSource(OMT)) return;
  for (const f of map.querySourceFeatures(OMT, { sourceLayer: 'building' })) {
    const id = f.id as number | undefined;
    if (id == null || styled.has(id)) continue;
    const rec = records.get(osmIdFromTileId(id));
    if (!rec) continue;
    styled.add(id);
    map.setFeatureState({ source: OMT, sourceLayer: 'building', id }, { use: USE_INDEX.get(rec.category) });
  }
}

const COLUMN_COLORS: Record<ColumnMetric, string> = {
  population: '#38bdf8',
  energy: '#f59e0b',
  traffic: '#f97316',
  pm25: '#a78bfa',
};

/**
 * Illustrative vegetation: deterministic points inside OSM park / wood polygons in view
 * (~1 tree per 220 m²). Positions are NOT surveyed trees — the layer legend says so.
 */
function sampleParkTrees(map: maplibregl.Map, cap: number): TreePoint[] {
  if (cap <= 0) return [];
  const b = map.getBounds();
  const feats = [
    ...map.querySourceFeatures(OMT, { sourceLayer: 'park' }),
    ...map.querySourceFeatures(OMT, { sourceLayer: 'landcover', filter: ['match', ['get', 'class'], ['wood', 'grass'], true, false] }),
  ];
  const out: TreePoint[] = [];
  const seen = new Set<string>();
  for (const f of feats) {
    const g = f.geometry;
    if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const rings of polys) {
      const outer = rings[0] as [number, number][];
      let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of outer) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
      if (e < b.getWest() || w > b.getEast() || n < b.getSouth() || s > b.getNorth()) continue;
      const k = `${w.toFixed(5)},${s.toFixed(5)}`;
      if (seen.has(k)) continue; // same polygon from overlapping tiles
      seen.add(k);
      const areaM2 = ringAreaM2(outer);
      const rand = seeded(hashCoord(w, s));
      const target = Math.min(400, Math.round(areaM2 / 220));
      for (let i = 0, tries = 0; i < target && tries < target * 3; tries++) {
        const p: [number, number] = [w + rand() * (e - w), s + rand() * (n - s)];
        if (!pointInRing(p[0], p[1], outer)) continue;
        out.push({ lon: p[0], lat: p[1], mapped: false, seed: rand() });
        i++;
        if (out.length >= cap) return out;
      }
    }
  }
  return out;
}

function addOverlays(map: maplibregl.Map) {
  map.addSource('zones', { type: 'geojson', data: EMPTY });
  map.addSource('zone-centers', { type: 'geojson', data: EMPTY });
  map.addSource('air', { type: 'geojson', data: EMPTY });
  map.addSource('traffic', { type: 'geojson', data: EMPTY });
  map.addSource('incidents', { type: 'geojson', data: EMPTY });
  map.addSource('selected', { type: 'geojson', data: EMPTY });
  map.addSource('traffic-live', { type: 'geojson', data: EMPTY });
  map.addSource('stations', { type: 'geojson', data: EMPTY });

  // Live road segments (measured speeds / disruption streets): drawn above buildings' base.
  map.addLayer({
    id: 'traffic-live-casing',
    type: 'line',
    source: 'traffic-live',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#060b16', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 3, 16, 10], 'line-opacity': 0.7 },
  });
  map.addLayer({
    id: 'traffic-live',
    type: 'line',
    source: 'traffic-live',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['case', ['<', ['get', 'congestion'], 0], '#64748b', ['step', ['get', 'congestion'], '#22c55e', 30, '#eab308', 55, '#f97316', 75, '#ef4444']],
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.6, 16, 6],
    },
  });

  // Ground stations: reference monitors large with white ring, low-cost sensors small.
  const pmColor: ExpressionSpecification = ['case', ['<', ['get', 'pm'], 0], '#64748b', ['step', ['get', 'pm'], '#22c55e', 10, '#84cc16', 20, '#eab308', 25, '#f97316', 50, '#ef4444', 75, '#a855f7']];
  map.addLayer({
    id: 'stations-halo',
    type: 'circle',
    source: 'stations',
    filter: ['==', ['get', 'ref'], true],
    paint: { 'circle-radius': 14, 'circle-color': pmColor, 'circle-opacity': 0.18 },
  });
  map.addLayer({
    id: 'stations-circle',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-radius': ['case', ['get', 'ref'], 7, 4],
      'circle-color': pmColor,
      'circle-stroke-color': ['case', ['get', 'ref'], '#ffffff', '#0a1120'],
      'circle-stroke-width': ['case', ['get', 'ref'], 2, 1],
    },
  });
  map.addLayer({
    id: 'stations-label',
    type: 'symbol',
    source: 'stations',
    minzoom: 11,
    filter: ['==', ['get', 'ref'], true],
    layout: { 'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': 10, 'text-offset': [0, 1.5], 'text-anchor': 'top' },
    paint: { 'text-color': '#e2e8f3', 'text-halo-color': '#0a1120', 'text-halo-width': 1.5 },
  });

  // Zone hit-testing layer (always rendered, transparent).
  map.addLayer({ id: 'zones-hit', type: 'fill', source: 'zones', paint: { 'fill-color': '#000', 'fill-opacity': 0 } }, 'bld-2d');

  map.addLayer({
    id: 'energy-fill',
    type: 'fill',
    source: 'zones',
    paint: {
      'fill-color': ['interpolate', ['linear'], ['get', 'energyRatio'], 0.85, '#1e40af', 1.0, '#0e7490', 1.15, '#ca8a04', 1.35, '#dc2626'],
      'fill-opacity': 0.38,
    },
  }, 'bld-2d');

  map.addLayer({
    id: 'air-zone-fill',
    type: 'fill',
    source: 'zones',
    filter: ['>=', ['get', 'aqi'], 0],
    paint: {
      'fill-color': ['step', ['get', 'aqi'], '#22c55e', 20, '#84cc16', 40, '#eab308', 60, '#f97316', 80, '#ef4444', 100, '#a855f7'],
      'fill-opacity': 0.28,
    },
  }, 'bld-2d');

  map.addLayer({
    id: 'air-heat',
    type: 'heatmap',
    source: 'air',
    maxzoom: 13,
    paint: {
      'heatmap-weight': ['interpolate', ['linear'], ['get', 'pm25'], 0, 0, 50, 1],
      'heatmap-intensity': 1,
      'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 8, 40, 12, 260],
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.7, 13, 0],
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.2, '#22c55e', 0.4, '#eab308', 0.7, '#f97316', 1, '#ef4444'],
    },
  });

  map.addLayer({
    id: 'zones-outline',
    type: 'line',
    source: 'zones',
    paint: { 'line-color': '#22d3ee', 'line-opacity': 0.45, 'line-width': 1, 'line-dasharray': [2, 2] },
  });

  map.addLayer({
    id: 'traffic-casing',
    type: 'line',
    source: 'traffic',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#060b16', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 2, 16, 8, 18, 16], 'line-opacity': 0.6 },
  }, 'bld-2d');
  map.addLayer({
    id: 'traffic-line',
    type: 'line',
    source: 'traffic',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['step', ['get', 'congestion'], '#22c55e', 30, '#eab308', 55, '#f97316', 75, '#ef4444'],
      'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 1, 16, ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], 5, ['secondary', 'tertiary'], 3.5, 2], 18, 10],
      'line-opacity': 0.9,
    },
  }, 'bld-2d');

  map.addLayer({
    id: 'air-points',
    type: 'circle',
    source: 'air',
    paint: {
      'circle-radius': 6,
      'circle-color': ['step', ['get', 'aqi'], '#22c55e', 20, '#84cc16', 40, '#eab308', 60, '#f97316', 80, '#ef4444', 100, '#a855f7'],
      'circle-stroke-color': '#0a1120',
      'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'air-labels',
    type: 'symbol',
    source: 'air',
    layout: { 'text-field': ['concat', 'PM2.5 ', ['get', 'label']], 'text-font': FONT, 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top' },
    paint: { 'text-color': '#e2e8f3', 'text-halo-color': '#0a1120', 'text-halo-width': 1.5 },
  });

  map.addLayer({
    id: 'zones-label',
    type: 'symbol',
    source: 'zone-centers',
    layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 11, 'text-letter-spacing': 0.1 },
    paint: { 'text-color': '#67e8f9', 'text-halo-color': '#0a1120', 'text-halo-width': 1.6 },
  });

  map.addLayer({
    id: 'incidents-halo',
    type: 'circle',
    source: 'incidents',
    paint: { 'circle-radius': 14, 'circle-color': ['match', ['get', 'kind'], 'closure', '#ef4444', '#f97316'], 'circle-opacity': 0.2 },
  });
  map.addLayer({
    id: 'incidents-circle',
    type: 'circle',
    source: 'incidents',
    paint: {
      'circle-radius': 6,
      'circle-color': ['match', ['get', 'kind'], 'closure', '#ef4444', '#f97316'],
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 1.5,
    },
  });

  // Selection highlight
  map.addLayer({
    id: 'selected-3d',
    type: 'fill-extrusion',
    source: 'selected',
    filter: ['==', ['get', 'kind'], 'building'],
    paint: { 'fill-extrusion-color': '#22d3ee', 'fill-extrusion-height': ['+', ['get', 'h'], 0.5], 'fill-extrusion-base': ['get', 'b'], 'fill-extrusion-opacity': 0.85 },
  });
  map.addLayer({
    id: 'selected-fill',
    type: 'fill',
    source: 'selected',
    filter: ['==', ['get', 'kind'], 'building'],
    layout: { visibility: 'none' },
    paint: { 'fill-color': '#22d3ee', 'fill-opacity': 0.7 },
  });
  map.addLayer({
    id: 'selected-line',
    type: 'line',
    source: 'selected',
    filter: ['match', ['get', 'kind'], ['road', 'zone'], true, false],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'selected-point',
    type: 'circle',
    source: 'selected',
    filter: ['==', ['get', 'kind'], 'place'],
    paint: { 'circle-radius': 8, 'circle-color': '#22d3ee', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  });
}

/**
 * Builds the traffic overlay from road segments currently loaded in the vector tiles.
 * Congestion values are SIMULATED (stable per location, scaled by the city-wide index).
 */
function computeTraffic(map: maplibregl.Map, cityLevel: number): FC {
  if (!map.getSource(OMT) || map.getZoom() < 11.5) return EMPTY;
  const feats = map.querySourceFeatures(OMT, {
    sourceLayer: 'transportation',
    filter: ['match', ['get', 'class'], TRAFFIC_CLASSES, true, false],
  });
  const out: GeoJSON.Feature[] = [];
  for (const f of feats.slice(0, 8000)) {
    const g = f.geometry;
    const first = g.type === 'LineString' ? g.coordinates[0] : g.type === 'MultiLineString' ? g.coordinates[0]?.[0] : undefined;
    if (!first) continue;
    const cls = String(f.properties.class);
    out.push({
      type: 'Feature',
      geometry: g,
      properties: { ...f.properties, congestion: roadCongestion(cls, first[0], first[1], cityLevel) },
    });
  }
  return { type: 'FeatureCollection', features: out };
}

function handleClick(f: MapGeoJSONFeature, at: maplibregl.LngLat, select: ReturnType<typeof useAppStore.getState>['select']) {
  const layer = f.layer.id;
  if (layer === 'traffic-line' || layer === 'traffic-live') {
    select({ kind: 'road', lon: at.lng, lat: at.lat, congestion: Number(f.properties.congestion), props: { ...f.properties, __geometry: f.geometry } });
  } else if (layer === 'incidents-circle') {
    select({ kind: 'incident', incidentId: String(f.properties.id) });
  } else if (layer === 'stations-circle') {
    select({ kind: 'station', stationId: String(f.properties.id) });
  } else if (layer === 'bld-3d' || layer === 'bld-2d') {
    const g = f.geometry;
    const ring = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : [];
    select({ kind: 'building', lon: at.lng, lat: at.lat, props: { ...f.properties, __tileId: f.id, __areaM2: ringAreaM2(ring), __geometry: g } });
  } else if (layer === 'zones-hit') {
    select({ kind: 'zone', zoneId: String(f.properties.id) });
  }
}
