import type { ExpressionSpecification, StyleSpecification } from 'maplibre-gl';

/**
 * Custom dark "control room" basemap over OpenStreetMap vector tiles served by
 * OpenFreeMap (OpenMapTiles schema, no API key). Overlay layers (traffic, air,
 * zones…) are added at runtime in CityMap.
 */
export const OMT = 'omt';
export const FONT = ['Noto Sans Regular'];

const ROAD_MAJOR = ['motorway', 'trunk', 'primary'];
const ROAD_MID = ['secondary', 'tertiary'];

export function buildStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      [OMT]: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution:
          '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
      },
    },
    light: { anchor: 'viewport', color: '#ffffff', intensity: 0.35, position: [1.2, 210, 30] },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#0a1120' } },
      {
        id: 'landuse',
        type: 'fill',
        source: OMT,
        'source-layer': 'landuse',
        paint: { 'fill-color': '#0d1729', 'fill-opacity': 0.8 },
      },
      {
        id: 'green-landcover',
        type: 'fill',
        source: OMT,
        'source-layer': 'landcover',
        filter: ['match', ['get', 'class'], ['grass', 'wood', 'farmland', 'wetland'], true, false],
        paint: { 'fill-color': '#0f2a24', 'fill-opacity': 0.75 },
      },
      {
        id: 'green-park',
        type: 'fill',
        source: OMT,
        'source-layer': 'park',
        paint: { 'fill-color': '#113126', 'fill-outline-color': '#1a4a39', 'fill-opacity': 0.85 },
      },
      { id: 'water', type: 'fill', source: OMT, 'source-layer': 'water', paint: { 'fill-color': '#071a33' } },
      {
        id: 'waterway',
        type: 'line',
        source: OMT,
        'source-layer': 'waterway',
        paint: { 'line-color': '#0b2545', 'line-width': 1.2 },
      },
      {
        id: 'road-minor',
        type: 'line',
        source: OMT,
        'source-layer': 'transportation',
        filter: ['match', ['get', 'class'], ['minor', 'service', 'track'], true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#17233a',
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 0.5, 16, 3, 18, 8],
        },
      },
      {
        id: 'road-mid',
        type: 'line',
        source: OMT,
        'source-layer': 'transportation',
        filter: ['match', ['get', 'class'], ROAD_MID, true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#1e2d4a',
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 0.6, 16, 5, 18, 12],
        },
      },
      {
        id: 'road-major',
        type: 'line',
        source: OMT,
        'source-layer': 'transportation',
        filter: ['match', ['get', 'class'], ROAD_MAJOR, true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#253a5e',
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 0.8, 16, 7, 18, 16],
        },
      },
      {
        id: 'transit-rail',
        type: 'line',
        source: OMT,
        'source-layer': 'transportation',
        filter: ['match', ['get', 'class'], ['rail', 'transit'], true, false],
        paint: {
          'line-color': '#22d3ee',
          'line-opacity': 0.75,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 16, 2.4],
          'line-dasharray': [3, 2],
        },
      },
      {
        id: 'bld-2d',
        type: 'fill',
        source: OMT,
        'source-layer': 'building',
        minzoom: 13,
        layout: { visibility: 'none' },
        paint: {
          'fill-color': HEIGHT_COLOR_2D,
          'fill-outline-color': '#2c4670',
        },
      },
      {
        id: 'bld-3d',
        type: 'fill-extrusion',
        source: OMT,
        'source-layer': 'building',
        minzoom: 13,
        filter: ['!=', ['get', 'hide_3d'], true],
        paint: {
          'fill-extrusion-color': HEIGHT_COLOR_3D,
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 14, ['coalesce', ['get', 'render_height'], 0]],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.92,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      {
        id: 'road-label',
        type: 'symbol',
        source: OMT,
        'source-layer': 'transportation_name',
        minzoom: 14,
        filter: ['match', ['get', 'class'], [...ROAD_MAJOR, ...ROAD_MID], true, false],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
          'text-font': FONT,
          'text-size': 10.5,
        },
        paint: { 'text-color': '#7e90b3', 'text-halo-color': '#0a1120', 'text-halo-width': 1.4 },
      },
      {
        id: 'place-label',
        type: 'symbol',
        source: OMT,
        'source-layer': 'place',
        filter: ['match', ['get', 'class'], ['city', 'town', 'suburb', 'quarter', 'neighbourhood'], true, false],
        layout: {
          'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
          'text-font': FONT,
          'text-size': ['match', ['get', 'class'], 'city', 15, 'town', 13, 11],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.12,
          'text-max-width': 8,
        },
        paint: { 'text-color': '#9fb0cf', 'text-halo-color': '#0a1120', 'text-halo-width': 1.6 },
      },
    ],
  };
}

// ------------------------------------------------------------ building colouring

type Expr = ExpressionSpecification;

export const HEIGHT_COLOR_3D: Expr = [
  'interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 0],
  0, '#1b2946', 20, '#20365c', 60, '#2a4c80', 150, '#3a6aaf',
];
export const HEIGHT_COLOR_2D: Expr = ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 0], 0, '#1a2742', 40, '#24406b', 120, '#3762a3'];

/**
 * Colour by OSM use category, read from feature-state `use` (index into `colors`) that
 * CityMap sets from imported building attributes. Unimported buildings stay muted.
 */
export function useColorExpr(colors: readonly string[]): Expr {
  const stops: (number | string)[] = [];
  colors.forEach((c, i) => stops.push(i, c));
  return ['match', ['coalesce', ['feature-state', 'use'], -1], ...stops, '#2b3a55'] as unknown as Expr;
}
