import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';

it('records an eager viewer folded into the entry so the production gate rejects it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ff-module-manifest-'));
  try {
    const viewerDirectory = join(root, 'src/client/features/workspace');
    mkdirSync(viewerDirectory, { recursive: true });
    // Keep a viewer function in the output; pure constants are optimized away.
    writeFileSync(
      join(viewerDirectory, 'file-viewer.tsx'),
      'export function viewer() { return location.pathname; }'
    );
    writeFileSync(
      join(root, 'entry.js'),
      'import { viewer } from "./src/client/features/workspace/file-viewer.tsx"; globalThis.renderViewer = viewer;'
    );
    await build({
      configFile: resolve('vite.config.ts'),
      root,
      publicDir: false,
      logLevel: 'silent',
      build: {
        outDir: join(root, 'dist/client'),
        rolldownOptions: {
          input: join(root, 'entry.js'),
          output: { entryFileNames: 'assets/index-fixture.js' },
        },
      },
    });
    const assets = join(root, 'dist/client/assets');
    expect(existsSync(join(assets, 'client-modules.json'))).toBe(true);
    // Keep the unchanged individual gates satisfied; the eager source is in index.
    writeFileSync(join(assets, 'file-viewer-lazy.js'), '');
    writeFileSync(join(assets, 'diff-highlight.worker-lazy.js'), '');
    const result = spawnSync(process.execPath, [resolve('scripts/check-client-chunk-budget.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('file-viewer.tsx must remain deferred');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
