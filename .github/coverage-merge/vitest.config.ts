import { defineConfig } from 'vitest/config';
import { coverage } from '../../vitest.coverage';

export default defineConfig({
  test: {
    // Blob tasks retain their project names; no test setup or native modules
    // are needed to merge the coverage maps already produced by the shards.
    projects: ['isolated', 'frontend', 'shared'].map((name) => ({
      test: { name, include: [] },
    })),
    coverage,
  },
});
