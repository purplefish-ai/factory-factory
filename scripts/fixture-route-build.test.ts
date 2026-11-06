import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';

const entry = resolve('src/client/router.tsx');
const fixtureRoutes = [
  './routes/mobile-baseline',
  './routes/transcript-scroll-fixture',
  resolve('src/client/routes/mobile-baseline.tsx'),
  resolve('src/client/routes/transcript-scroll-fixture.tsx'),
];

it.each([
  { mode: 'production', mobileBaseline: '', expected: [] },
  { mode: 'production', mobileBaseline: '1', expected: ['mobile-baseline'] },
  {
    mode: 'development',
    mobileBaseline: '',
    expected: ['mobile-baseline', 'transcript-scroll-fixture'],
  },
])(
  'bundles only enabled fixture routes in $mode with opt-in "$mobileBaseline"',
  async ({ mode, mobileBaseline, expected }) => {
    const output = mkdtempSync(join(tmpdir(), 'ff-fixture-route-build-'));
    try {
      await build({
        configFile: false,
        mode,
        logLevel: 'silent',
        define: { 'import.meta.env.VITE_ENABLE_MOBILE_BASELINE': JSON.stringify(mobileBaseline) },
        build: {
          outDir: output,
          rolldownOptions: {
            input: entry,
            // Exercise the real router and fixture modules; unrelated app dependencies
            // stay external so this regression does not rebuild the entire application.
            external: (id) => id !== entry && !fixtureRoutes.includes(id),
            output: { chunkFileNames: '[name].js' },
          },
        },
      });
      const chunks = readdirSync(output)
        .filter((file) => fixtureRoutes.some((route) => file === `${route.split('/').at(-1)}.js`))
        .map((file) => file.replace(/\.js$/, ''))
        .sort();
      expect(chunks).toEqual(expected);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }
);
