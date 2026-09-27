import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// index.html carries `__SITE_ORIGIN__` for absolute social-card URLs; the engine fills it in per
// request in production. The dev server has no public origin, so it becomes relative there.
const devOrigin: Plugin = {
  name: 'site-dev-origin',
  apply: 'serve',
  transformIndexHtml: (html) => html.replaceAll('__SITE_ORIGIN__', ''),
};

// The engine serves the JSON API and the SSE stream under /api. http-proxy pipes responses
// without buffering, so `text/event-stream` flows through unchanged.
const api = {
  '/api': {
    target: process.env.ENGINE_URL ?? 'http://localhost:8787',
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react(), devOrigin],
  // Build timestamp for "Last updated" lines (docs); ISO 8601, set once per build.
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  server: { port: 5173, proxy: api },
  preview: { port: 4173, proxy: api },
  build: { target: 'es2022', sourcemap: true },
});
