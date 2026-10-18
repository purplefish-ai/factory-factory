import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const declared =
  typeof manifest === 'object' && manifest !== null ? manifest.packageManager : undefined;
if (typeof declared !== 'string' || !/^pnpm@\d+\.\d+\.\d+(?:\+.+)?$/.test(declared)) {
  throw new Error('Declare an exact pnpm version in package.json#packageManager');
}
const version = declared.slice('pnpm@'.length).split('+')[0];
// Native pnpm generates this complete value unless its user-agent is overridden.
const expected = `pnpm/${version} npm/? node/? ${process.platform} ${process.arch}`;

// pmOnFail: ignore keeps GitHub's dependency graph on the project lockfile.
// Preserve version enforcement for installs, lock-only updates, run and exec.
export const hooks = {
  updateConfig(config) {
    const actual = config.userAgent;
    if (actual !== expected) {
      throw new Error(
        `Use ${declared} with its default user-agent; custom user-agent values are unsupported (received: ${actual ?? 'unknown'})`
      );
    }
    return config;
  },
};
