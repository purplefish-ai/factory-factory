import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/nextjs-vite';
import tailwindcss from '@tailwindcss/vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  stories: [
    '../src/components/**/*.stories.@(js|jsx|ts|tsx)',
    '../src/frontend/components/**/*.stories.@(js|jsx|ts|tsx)',
  ],

  addons: ['@storybook/addon-themes', '@storybook/addon-a11y', '@storybook/addon-mcp'],

  framework: {
    name: '@storybook/nextjs-vite',
    options: {},
  },

  staticDirs: ['../public'],

  viteFinal(config) {
    config.plugins = config.plugins || [];
    config.plugins.push(tailwindcss());

    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': path.resolve(__dirname, '../src'),
      '@prisma-gen': path.resolve(__dirname, '../prisma/generated'),
    };

    return config;
  },

  typescript: {
    reactDocgen: 'react-docgen-typescript',
    check: false,
  },

  docs: {},
};

export default config;
