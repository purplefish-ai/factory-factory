import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { workerSafeAliases } from './scripts/vite-worker-aliases.ts';

// Backend URL is set by the CLI when running in development mode
const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';

// Base path for Vite asset URLs.
// - Default '/' uses absolute paths, required for deep route hard-refresh to work correctly
//   (relative paths would resolve against the current URL path, e.g. /projects/123/assets/).
// - Set VITE_BASE_PATH='./' for reverse proxy deployments where the app is served under a
//   deep path prefix (e.g. /machine/<id>/api/port/<portId>/).
const basePath = process.env.VITE_BASE_PATH || '/';

// Installation URLs must not follow the current SPA route, even when JS assets
// use a relative base. Relative proxy builds can supply their deployment prefix.
const webAppBase =
  process.env.VITE_WEB_APP_BASE_PATH || (basePath.startsWith('/') ? basePath : '/');
if (!/^\/(?![/\\])[^?#\\]*$/.test(webAppBase)) {
  throw new Error('VITE_WEB_APP_BASE_PATH must be an absolute same-origin path');
}
const webAppBasePath = webAppBase.endsWith('/') ? webAppBase : `${webAppBase}/`;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'web-app-metadata',
      transformIndexHtml: () => [
        {
          tag: 'link',
          attrs: { rel: 'manifest', href: `${webAppBasePath}manifest.webmanifest` },
          injectTo: 'head',
        },
        {
          tag: 'link',
          attrs: {
            rel: 'apple-touch-icon',
            sizes: '180x180',
            href: `${webAppBasePath}icons/apple-touch-icon.png`,
          },
          injectTo: 'head',
        },
      ],
    },
  ],
  envPrefix: 'VITE_',
  define: {
    'import.meta.env.DEBUG_CHAT_WS': JSON.stringify(process.env.DEBUG_CHAT_WS ?? ''),
  },
  resolve: {
    alias: {
      ...workerSafeAliases,
      '@': resolve(import.meta.dirname, './src'),
      '@prisma-gen': resolve(import.meta.dirname, './prisma/generated'),
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
      '/setup-terminal': {
        target: backendUrl.replace(/^http/, 'ws'),
        ws: true,
      },
      '/dev-logs': {
        target: backendUrl.replace(/^http/, 'ws'),
        ws: true,
      },
      '/post-run-logs': {
        target: backendUrl.replace(/^http/, 'ws'),
        ws: true,
      },
      '/snapshots': {
        target: backendUrl.replace(/^http/, 'ws'),
        ws: true,
      },
      '/voice': {
        target: backendUrl.replace(/^http/, 'ws'),
        ws: true,
      },
    },
  },
});
