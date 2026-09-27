import { defineConfig } from 'vite';

// In development the API runs on :8080 (pnpm dev:server); the browser only talks to its own origin.
// VITE_PROXY_TARGET overrides the proxy target (used in Docker compose where the server is another container).
export default defineConfig({
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    proxy: { '/api': { target: process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:8080', changeOrigin: false } }
  },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022', chunkSizeWarningLimit: 900 }
});
