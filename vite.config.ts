import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Backend URL is set by the CLI when running in development mode
const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@prisma-gen': resolve(__dirname, './prisma/generated'),
    },
  },
  build: {
    outDir: 'dist/client',
    chunkSizeWarningLimit: 3000,
  },
  server: {
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
    },
  },
});
