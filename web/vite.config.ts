import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The production app is a static bundle on S3 behind CloudFront; `/api` is a
// separate CloudFront behaviour pointing at Lambda, so there is no CORS in prod.
// In dev we proxy `/api` and `/media` to the local mock API (scripts/dev-api.mjs).
// The smoke test runs the dev API on its own port to avoid clashing with a
// developer's running instance.
const apiTarget = `http://localhost:${process.env.VITE_API_PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/media': { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    // hls.js is large but loads only on the watch page, so the warning is noise.
    chunkSizeWarningLimit: 700,
    sourcemap: true,
    rollupOptions: {
      output: {
        // Split the player out so the browse page ships less JS.
        manualChunks: { hls: ['hls.js'] },
      },
    },
  },
});
