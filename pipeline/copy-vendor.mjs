/**
 * Copies MapLibre's self-contained worker into public/vendor so it is served as a plain
 * static file. Vite's `?worker` transform injects its dev client (/@vite/client) into
 * worker bundles, which touches `document` and intermittently kills the map worker.
 * Runs automatically before `npm run dev` / `npm run build`.
 */
import { copyFile, mkdir } from 'node:fs/promises';

const src = new URL('../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url);
const dir = new URL('../public/vendor/', import.meta.url);
await mkdir(dir, { recursive: true });
await copyFile(src, new URL('maplibre-gl-worker.mjs', dir));
console.log('copied maplibre-gl-worker.mjs → public/vendor/');
