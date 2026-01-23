import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/frontend/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/frontend/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/frontend/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
