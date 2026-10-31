import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const api = process.env.STEVE_API || 'http://localhost:8740';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5178,
    proxy: Object.fromEntries(['/v1', '/api/v1', '/mcp', '/openapi.json', '/health', '/share'].map((path) => [path, { target: api, changeOrigin: false }])),
  },
  build: {
    chunkSizeWarningLimit: 2500,
    sourcemap: false,
    rolldownOptions: {
      // The app, and the public page behind share links (no sign-in; app/shares.py serves it at /share/<token>).
      input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), share: fileURLToPath(new URL('./share.html', import.meta.url)) },
      output: {
        // Long-lived vendor chunks cache across app deploys.
        advancedChunks: {
          groups: [
            { name: 'three', test: /node_modules[\\/](three|three-stdlib|camera-controls|three-mesh-bvh)[\\/]/ },
            { name: 'r3f', test: /node_modules[\\/]@react-three[\\/]/ },
            { name: 'ui', test: /node_modules[\\/](react|react-dom|scheduler|motion|motion-dom|framer-motion|radix-ui|@radix-ui|cmdk|lucide-react|zustand)[\\/]/ },
          ],
        },
      },
    },
  },
});
