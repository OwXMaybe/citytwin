import { elementToPolygon, polyGeomAreaM2, polyGeomCenter, type LonLat, type OverpassElement } from './geometry';

/** Building use categories derived from OSM tags. Index order is used by map feature-state. */
export const USE_CATEGORIES = [
  { id: 'residential', label: 'Residential', color: '#3b82f6' },
  { id: 'commercial', label: 'Commercial / office', color: '#f59e0b' },
  { id: 'industrial', label: 'Industrial', color: '#a78bfa' },
  { id: 'civic', label: 'Public / civic', color: '#22d3ee' },
  { id: 'education', label: 'Education', color: '#22c55e' },
  { id: 'health', label: 'Health', color: '#f43f5e' },
  { id: 'religious', label: 'Religious', color: '#eab308' },
  { id: 'transport', label: 'Transport', color: '#14b8a6' },
  { id: 'other', label: 'Other / unspecified', color: '#64748b' },
] as const;

export type UseCategory = (typeof USE_CATEGORIES)[number]['id'];

const BY_BUILDING: Record<string, UseCategory> = {
  apartments: 'residential', residential: 'residential', house: 'residential', detached: 'residential', semidetached_house: 'residential',
  terrace: 'residential', dormitory: 'residential', bungalow: 'residential', villa: 'residential',
  commercial: 'commercial', office: 'commercial', retail: 'commercial', shop: 'commercial', supermarket: 'commercial', hotel: 'commercial', kiosk: 'commercial', mall: 'commercial',
  industrial: 'industrial', warehouse: 'industrial', factory: 'industrial', manufacture: 'industrial', storage_tank: 'industrial',
  public: 'civic', civic: 'civic', government: 'civic', townhall: 'civic', fire_station: 'civic', police: 'civic', museum: 'civic', library: 'civic',
  school: 'education', university: 'education', college: 'education', kindergarten: 'education',
  hospital: 'health', clinic: 'health',
  church: 'religious', mosque: 'religious', cathedral: 'religious', chapel: 'religious', synagogue: 'religious', temple: 'religious', religious: 'religious',
  train_station: 'transport', transportation: 'transport', parking: 'transport', garage: 'transport', garages: 'transport',
};

const BY_AMENITY: Record<string, UseCategory> = {
  school: 'education', university: 'education', college: 'education', kindergarten: 'education',
  hospital: 'health', clinic: 'health', doctors: 'health', pharmacy: 'health',
  place_of_worship: 'religious', townhall: 'civic', police: 'civic', fire_station: 'civic', library: 'civic', courthouse: 'civic',
  restaurant: 'commercial', cafe: 'commercial', bank: 'commercial', marketplace: 'commercial', parking: 'transport',
};

export function classifyBuilding(tags: Record<string, string>): UseCategory {
  if (tags.amenity && BY_AMENITY[tags.amenity]) return BY_AMENITY[tags.amenity];
  if (tags.building && BY_BUILDING[tags.building]) return BY_BUILDING[tags.building];
  if (tags.shop || tags.office || tags.tourism === 'hotel') return 'commercial';
  if (tags['building:use'] && BY_BUILDING[tags['building:use']]) return BY_BUILDING[tags['building:use']];
  return 'other';
}

export interface BuildingRecord {
  osmType: 'way' | 'relation';
  osmId: number;
  category: UseCategory;
  buildingTag: string;
  name: string | null;
  levels: number | null; // building:levels (tagged)
  heightM: number | null; // height (tagged)
  roofShape: string | null;
  material: string | null;
  startDate: string | null;
  address: string | null;
  amenity: string | null;
  footprintM2: number;
  center: LonLat;
}

const num = (v?: string) => {
  if (!v) return null;
  const n = parseFloat(v.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/**
 * OpenFreeMap (planetiler) building feature ids are osmId * 10 + a small suffix, so the
 * OSM id is recovered with floor(id / 10). Way and relation ids share this space.
 */
export const osmIdFromTileId = (tileId: number) => Math.floor(tileId / 10);

export function toBuildingRecord(el: OverpassElement): BuildingRecord | null {
  if (el.type === 'node' || !el.tags?.building) return null;
  const geom = elementToPolygon(el);
  if (!geom) return null;
  const t = el.tags;
  const addr = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
  return {
    osmType: el.type,
    osmId: el.id,
    category: classifyBuilding(t),
    buildingTag: t.building,
    name: t.name ?? null,
    levels: num(t['building:levels']),
    heightM: num(t.height),
    roofShape: t['roof:shape'] ?? null,
    material: t['building:material'] ?? null,
    startDate: t.start_date ?? null,
    address: addr ? [addr, t['addr:postcode'], t['addr:city']].filter(Boolean).join(', ') : null,
    amenity: t.amenity ?? t.shop ?? t.office ?? null,
    footprintM2: Math.round(polyGeomAreaM2(geom)),
    center: polyGeomCenter(geom),
  };
}

export interface OsmImport {
  buildings: BuildingRecord[];
  trees: LonLat[];
  source: string; // "Overpass (overpass-api.de)" or file name
  osmTimestamp: string | null;
  importedAt: string;
  bbox: [number, number, number, number] | null; // w, s, e, n
}

export function elementsToImport(elements: OverpassElement[], meta: Omit<OsmImport, 'buildings' | 'trees' | 'importedAt'>): OsmImport {
  const buildings: BuildingRecord[] = [];
  const trees: LonLat[] = [];
  for (const el of elements) {
    if (el.type === 'node') {
      if (el.tags?.natural === 'tree') trees.push([el.lon, el.lat]);
      continue;
    }
    const b = toBuildingRecord(el);
    if (b) buildings.push(b);
  }
  return { ...meta, buildings, trees, importedAt: new Date().toISOString() };
}
