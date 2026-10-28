import type { OverpassElement } from './geometry';
import { elementsToImport, type OsmImport } from './buildings';

/**
 * Local file import: OSM XML (.osm, e.g. JOSM / openstreetmap.org export) or GeoJSON
 * exported from overpass-turbo. Both are normalised to Overpass-style elements and go
 * through the same building/tree extraction as live Overpass imports.
 */
export async function importOsmFile(file: File): Promise<OsmImport> {
  if (file.size > 60 * 1024 * 1024) throw new Error('File is larger than 60 MB — import a smaller extract.');
  const text = await file.text();
  const trimmed = text.trimStart();
  let elements: OverpassElement[];
  if (trimmed.startsWith('<')) elements = parseOsmXml(text);
  else if (trimmed.startsWith('{')) elements = parseGeoJson(JSON.parse(text));
  else throw new Error('Unrecognised file. Use OSM XML (.osm) or GeoJSON (.geojson).');
  const result = elementsToImport(elements, { source: `File: ${file.name}`, osmTimestamp: null, bbox: null });
  if (!result.buildings.length && !result.trees.length) throw new Error('No buildings or trees found in this file.');
  return result;
}

export function parseOsmXml(xml: string): OverpassElement[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid OSM XML.');
  const tagsOf = (el: Element) => {
    const t: Record<string, string> = {};
    el.querySelectorAll(':scope > tag').forEach((tg) => (t[tg.getAttribute('k')!] = tg.getAttribute('v')!));
    return t;
  };
  const nodes = new Map<string, { lat: number; lon: number }>();
  const out: OverpassElement[] = [];
  doc.querySelectorAll('osm > node').forEach((n) => {
    const p = { lat: +n.getAttribute('lat')!, lon: +n.getAttribute('lon')! };
    nodes.set(n.getAttribute('id')!, p);
    const tags = tagsOf(n);
    if (Object.keys(tags).length) out.push({ type: 'node', id: +n.getAttribute('id')!, ...p, tags });
  });
  const wayGeom = new Map<string, { lat: number; lon: number }[]>();
  doc.querySelectorAll('osm > way').forEach((w) => {
    const geom = [...w.querySelectorAll(':scope > nd')].map((nd) => nodes.get(nd.getAttribute('ref')!)).filter((p): p is { lat: number; lon: number } => !!p);
    wayGeom.set(w.getAttribute('id')!, geom);
    out.push({ type: 'way', id: +w.getAttribute('id')!, geometry: geom, tags: tagsOf(w) });
  });
  doc.querySelectorAll('osm > relation').forEach((r) => {
    out.push({
      type: 'relation',
      id: +r.getAttribute('id')!,
      tags: tagsOf(r),
      members: [...r.querySelectorAll(':scope > member')].map((m) => ({
        type: m.getAttribute('type')!,
        ref: +m.getAttribute('ref')!,
        role: m.getAttribute('role') ?? '',
        geometry: m.getAttribute('type') === 'way' ? wayGeom.get(m.getAttribute('ref')!) : undefined,
      })),
    });
  });
  return out;
}

/** overpass-turbo GeoJSON: ids like "way/123" in `id` or properties["@id"], tags as properties. */
export function parseGeoJson(fc: GeoJSON.FeatureCollection): OverpassElement[] {
  if (fc.type !== 'FeatureCollection') throw new Error('GeoJSON must be a FeatureCollection.');
  const out: OverpassElement[] = [];
  for (const f of fc.features) {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const rawId = String(p['@id'] ?? f.id ?? '');
    const m = /^(node|way|relation)\/(\d+)$/.exec(rawId);
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries((p.tags as Record<string, unknown>) ?? p)) if (!k.startsWith('@') && v != null) tags[k] = String(v);
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Point') {
      out.push({ type: 'node', id: m ? +m[2] : 0, lon: g.coordinates[0], lat: g.coordinates[1], tags });
    } else if (g.type === 'Polygon' && m && m[1] !== 'node') {
      const outer = g.coordinates[0].map(([lon, lat]) => ({ lat, lon }));
      if (m[1] === 'way') out.push({ type: 'way', id: +m[2], geometry: outer, tags });
      else out.push({ type: 'relation', id: +m[2], tags, members: g.coordinates.map((r, i) => ({ type: 'way', ref: 0, role: i ? 'inner' : 'outer', geometry: r.map(([lon, lat]) => ({ lat, lon })) })) });
    } else if (g.type === 'MultiPolygon' && m?.[1] === 'relation') {
      out.push({ type: 'relation', id: +m[2], tags, members: g.coordinates.flatMap((poly) => poly.map((r, i) => ({ type: 'way', ref: 0, role: i ? 'inner' : 'outer', geometry: r.map(([lon, lat]) => ({ lat, lon })) }))) });
    }
  }
  return out;
}
