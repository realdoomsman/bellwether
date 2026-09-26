import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// index.html carries `__FLOOR_ORIGIN__` for absolute social-card URLs; the engine fills it in per
// request in production. The dev server has no public origin, so it becomes relative there.
const devOrigin: Plugin = {
  name: 'floor-dev-origin',
  apply: 'serve',
  transformIndexHtml: (html) => html.replaceAll('__FLOOR_ORIGIN__', ''),
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
  server: { port: 5173, proxy: api },
  preview: { port: 4173, proxy: api },
  build: { target: 'es2022', sourcemap: true },
});
