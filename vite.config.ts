import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  /**
   * Same-origin proxies for feeds that don't send CORS headers or need a secret.
   * The OpenAQ key is injected here, server-side, and never reaches the browser.
   * Static production builds need an equivalent reverse proxy (Phase 4 backend).
   */
  const backend = env.CITYTWIN_BACKEND || 'http://127.0.0.1:8000';
  const proxy: Record<string, ProxyOptions> = {
    // Phase 4 backend (FastAPI). When it isn't running these return 5xx and the
    // frontend falls back to direct mode via the /proxy/* routes below.
    '/api': { target: backend, changeOrigin: true },
    '/ws': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
    '/proxy/ibb-traffic': {
      target: 'https://api.ibb.gov.tr',
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/proxy\/ibb-traffic/, '/tkmservices/api/TrafficData/v1'),
    },
    // İBB air API sends a duplicated Access-Control-Allow-Origin header, which browsers reject.
    '/proxy/ibb-air': {
      target: 'https://api.ibb.gov.tr',
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/proxy\/ibb-air/, '/havakalitesi/OpenDataPortalHandler'),
    },
    '/proxy/openaq': {
      target: 'https://api.openaq.org',
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/proxy\/openaq/, ''),
      headers: env.OPENAQ_API_KEY ? { 'X-API-Key': env.OPENAQ_API_KEY } : {},
    },
  };

  return {
    plugins: [react(), tailwindcss()],
    server: { port: 5173, proxy },
    preview: { proxy },
    // The lazy map chunk bundles MapLibre + Three.js (~1.6 MB); everything else is far smaller.
    build: { chunkSizeWarningLimit: 1800 },
  };
});
