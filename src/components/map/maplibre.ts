import * as maplibregl from 'maplibre-gl';

// Plain static copy of MapLibre's worker (see pipeline/copy-vendor.mjs) — never transformed by Vite.
maplibregl.setWorkerUrl(`${import.meta.env.BASE_URL}vendor/maplibre-gl-worker.mjs`);

export { maplibregl };
