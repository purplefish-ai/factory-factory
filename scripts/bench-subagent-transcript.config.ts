import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { transformWithOxc } from 'vite';
import { defineConfig } from 'vitest/config';
import base from '../vitest.config';

const baselineRevision = 'fc30bb563ef4d0dc66ca8e30a0ea4f87b640ecd6';
const baselineModule = 'virtual:subagent-transcript-baseline';
const resolvedBaselineModule = `\0${baselineModule}.ts`;
const root = path.resolve(import.meta.dirname, '..');
const projectorPath = 'src/client/features/chat/project-acp-transcript.ts';

export default defineConfig({
  ...base,
  plugins: [
    {
      name: 'subagent-transcript-baseline',
      resolveId(id, importer) {
        if (id === baselineModule) {
          return resolvedBaselineModule;
        }
        // Match the original comparison: only the projection function is
        // historical; its shared reducer and translator come from this checkout.
        if (importer === resolvedBaselineModule && id === './reducer') {
          return path.resolve(root, 'src/client/features/chat/reducer/index.ts');
        }
        return null;
      },
      load(id) {
        if (id !== resolvedBaselineModule) {
          return null;
        }
        const source = execFileSync('git', ['show', `${baselineRevision}:${projectorPath}`], {
          cwd: root,
          encoding: 'utf8',
        });
        return transformWithOxc(
          `${source}\nexport const baselineRevision = '${baselineRevision}';\n`,
          projectorPath
        );
      },
    },
  ],
  test: {
    ...base.test,
    include: ['scripts/bench-subagent-transcript.ts'],
    setupFiles: [],
    disableConsoleIntercept: true,
    testTimeout: 120_000,
    env: { NODE_ENV: 'production' },
  },
});
