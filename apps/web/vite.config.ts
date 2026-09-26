import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The engine serves the JSON API and the SSE stream under /api. http-proxy pipes responses
// without buffering, so `text/event-stream` flows through unchanged.
const api = {
  '/api': {
    target: process.env.ENGINE_URL ?? 'http://localhost:8787',
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: api },
  preview: { port: 4173, proxy: api },
  build: { target: 'es2022', sourcemap: true },
});
