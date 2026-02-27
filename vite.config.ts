import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Backend URL is set by the CLI when running in development mode
const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';

// Base path for Vite asset URLs.
// - Default '/' uses absolute paths, required for deep route hard-refresh to work correctly
//   (relative paths would resolve against the current URL path, e.g. /projects/123/assets/).
// - Set VITE_BASE_PATH='./' for reverse proxy deployments where the app is served under a
//   deep path prefix (e.g. /machine/<id>/api/port/<portId>/).
const basePath = process.env.VITE_BASE_PATH || '/';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  envPrefix: 'VITE_',
  define: {
    'import.meta.env.DEBUG_CHAT_WS': JSON.stringify(process.env.DEBUG_CHAT_WS ?? ''),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@prisma-gen': resolve(__dirname, './prisma/generated'),
    },
  },
  build: {
    outDir: 'dist/client',
    chunkSizeWarningLimit: 5000,
  },
  base: basePath,
  server: {
    allowedHosts: 'all',
    proxy: {
      '/api': {
        target: backendUrl,
        changeOrigin: true,
      },
      '/chat': {
        target: backendUrl.replace(/^http/, 'ws'),
        ws: true,
      },
      '/terminal': {
        target: backendUrl.replace(/^http/, 'ws'),
        ws: true,
      },
      '/dev-logs': {
        target: backendUrl.replace(/^http/, 'ws'),
        ws: true,
      },
      '/snapshots': {
        target: backendUrl.replace(/^http/, 'ws'),
        ws: true,
      },
    },
  },
});
