import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const declared =
  typeof manifest === 'object' && manifest !== null ? manifest.packageManager : undefined;
if (typeof declared !== 'string' || !/^pnpm@\d+\.\d+\.\d+(?:\+.+)?$/.test(declared)) {
  throw new Error('Declare an exact pnpm version in package.json#packageManager');
}
const expected = `pnpm/${declared.slice('pnpm@'.length).split('+')[0]}`;

// pmOnFail: ignore keeps GitHub's dependency graph on the project lockfile.
// Preserve version enforcement for installs, lock-only updates, run and exec.
export const hooks = {
  updateConfig(config) {
    const actual =
      typeof config.userAgent === 'string' ? config.userAgent.split(' ')[0] : undefined;
    if (actual !== expected) {
      throw new Error(
        `Use ${declared} for this repository (active manager: ${actual ?? 'unknown'})`
      );
    }
    return config;
  },
};
