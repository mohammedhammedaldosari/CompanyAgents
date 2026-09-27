import { defineConfig } from 'vite';

// In development the API runs on :8080 (pnpm dev:server); the browser only talks to its own origin.
export default defineConfig({
  server: { port: 5173, host: '0.0.0.0', proxy: { '/api': { target: process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:8080', changeOrigin: false } } },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022', chunkSizeWarningLimit: 900 }
});
