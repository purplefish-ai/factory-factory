import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'vite';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Build `files` with the app's Vite config and run the production gate on the output. */
async function buildAndCheck(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'ff-module-manifest-'));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), source);
  }
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
  // Keep the unchanged individual gates satisfied.
  writeFileSync(join(assets, 'file-viewer-lazy.js'), '');
  writeFileSync(join(assets, 'diff-highlight.worker-lazy.js'), '');
  const result = spawnSync(process.execPath, [resolve('scripts/check-client-chunk-budget.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  const manifest: unknown = JSON.parse(readFileSync(join(assets, 'client-modules.json'), 'utf8'));
  return { result, manifest };
}

it('records an eager viewer folded into the entry so the production gate rejects it', async () => {
  const { result } = await buildAndCheck({
    // Keep a viewer function in the output; pure constants are optimized away.
    'src/client/features/workspace/file-viewer.tsx':
      'export function viewer() { return location.pathname; }',
    'entry.js':
      'import { viewer } from "./src/client/features/workspace/file-viewer.tsx"; globalThis.renderViewer = viewer;',
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('file-viewer.tsx must remain deferred');
}, 60_000);

it('records package names so the gate rejects markdown in the board route closure', async () => {
  const { result, manifest } = await buildAndCheck({
    'node_modules/streamdown/package.json': JSON.stringify({
      name: 'streamdown',
      type: 'module',
      main: 'index.js',
    }),
    'node_modules/streamdown/index.js': 'export function render() { return location.hash; }',
    'src/client/routes/projects/workspaces/list.tsx':
      'import { render } from "streamdown"; export function board() { return render(); }',
    'entry.js':
      'globalThis.loadBoard = () => import("./src/client/routes/projects/workspaces/list.tsx");',
  });
  expect(manifest).toMatchObject({ version: 2 });
  expect(JSON.stringify(manifest)).not.toContain(tmpdir());
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/board route static closure must not contain streamdown/);
}, 60_000);
