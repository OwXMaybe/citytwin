/**
 * OSM district boundary import.
 *
 *   node pipeline/import-districts.ts            # all cities
 *   node pipeline/import-districts.ts berlin     # one city
 *
 * Fetches administrative boundaries from Overpass, assembles relation rings,
 * simplifies to ~25 m and writes public/data/districts/<city>.geojson plus an
 * index.json manifest. Phase 4 will load the same output into PostGIS.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DISTRICT_SOURCES } from '../src/data/districtSources.ts';
import { elementToPolygon, polyGeomAreaM2, polyGeomCenter, simplifyPolyGeom } from '../src/services/osm/geometry.ts';
import { runOverpass } from '../src/services/osm/overpass.ts';

const OUT_DIR = new URL('../public/data/districts/', import.meta.url);
const SIMPLIFY_M = 25;

interface ManifestEntry {
  cityId: string;
  count: number;
  osmTimestamp: string | null;
  importedAt: string;
  endpoint: string;
}

async function importCity(cityId: string): Promise<ManifestEntry> {
  const src = DISTRICT_SOURCES.find((s) => s.cityId === cityId);
  if (!src) throw new Error(`No district source configured for ${cityId}`);
  const query = `[out:json][timeout:180];
area(id:${3600000000 + src.areaRelation})->.a;
rel(area.a)["boundary"="administrative"]["admin_level"="${src.adminLevel}"];
out geom;`;
  const res = await runOverpass(query, {
    timeoutMs: 200_000,
    rounds: 3,
    userAgent: 'CityTwin-pipeline/0.2 (district import)',
    onAttempt: (ep, n) => console.log(`  [${cityId}] attempt ${n} → ${new URL(ep).host}`),
  });

  const features = [];
  for (const el of res.elements) {
    if (el.type !== 'relation') continue;
    const geom = elementToPolygon(el);
    if (!geom) {
      console.warn(`  [${cityId}] skipped relation ${el.id} (${el.tags?.name}) — rings did not close`);
      continue;
    }
    const tags = el.tags ?? {};
    const pop = Number(tags.population);
    features.push({
      type: 'Feature',
      id: el.id,
      properties: {
        osmId: el.id,
        name: tags.name ?? `Relation ${el.id}`,
        nameEn: tags['name:en'] ?? null,
        adminLevel: src.adminLevel,
        population: Number.isFinite(pop) && pop > 0 ? pop : null,
        populationDate: tags['population:date'] ?? null,
        wikidata: tags.wikidata ?? null,
        areaKm2: +(polyGeomAreaM2(geom) / 1e6).toFixed(3),
        center: polyGeomCenter(geom).map((v) => +v.toFixed(5)),
      },
      geometry: simplifyPolyGeom(geom, SIMPLIFY_M),
    });
  }
  if (!features.length) throw new Error(`Overpass returned no usable boundaries for ${cityId}`);
  features.sort((a, b) => a.properties.name.localeCompare(b.properties.name));

  const fc = {
    type: 'FeatureCollection',
    metadata: {
      cityId,
      source: 'OpenStreetMap contributors (ODbL) via Overpass API',
      unit: src.label,
      adminLevel: src.adminLevel,
      osmTimestamp: res.timestamp,
      importedAt: new Date().toISOString(),
      simplifiedToleranceM: SIMPLIFY_M,
    },
    features,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(new URL(`${cityId}.geojson`, OUT_DIR), JSON.stringify(fc));
  console.log(`  [${cityId}] wrote ${features.length} districts`);
  return { cityId, count: features.length, osmTimestamp: res.timestamp, importedAt: fc.metadata.importedAt, endpoint: res.endpoint };
}

async function main() {
  const only = process.argv.slice(2);
  const targets = only.length ? only : DISTRICT_SOURCES.map((s) => s.cityId);
  const manifestUrl = new URL('index.json', OUT_DIR);
  let manifest: Record<string, ManifestEntry> = {};
  try {
    manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  } catch {
    /* first run */
  }
  let failed = 0;
  for (const id of targets) {
    console.log(`Importing districts for ${id}…`);
    try {
      manifest[id] = await importCity(id);
    } catch (e) {
      failed++;
      console.error(`  [${id}] FAILED: ${(e as Error).message}`);
    }
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(manifestUrl, JSON.stringify(manifest, null, 2));
  }
  process.exitCode = failed ? 1 : 0;
}

main();
