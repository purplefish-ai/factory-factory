import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/chat': {
        target: 'ws://localhost:3000',
        ws: true,
      },
      '/terminal': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
});
