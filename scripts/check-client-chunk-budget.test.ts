import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkClientChunkBudget } from './check-client-chunk-budget.mjs';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function check(chunks: Record<string, string>, sourceModules?: Record<string, string[]> | null) {
  const root = mkdtempSync(join(tmpdir(), 'ff-client-budget-'));
  directories.push(root);
  const assets = join(root, 'dist/client/assets');
  mkdirSync(assets, { recursive: true });
  const files = {
    'index-entry.js': '',
    'file-viewer-lazy.js': '',
    'diff-highlight.worker-lazy.js': '',
    ...chunks,
  };
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(assets, name), source);
  }
  if (sourceModules !== null) {
    writeFileSync(
      join(assets, 'client-modules.json'),
      JSON.stringify({
        version: 1,
        modules: sourceModules ?? Object.fromEntries(Object.keys(files).map((name) => [name, []])),
      })
    );
  }
  const lines: string[] = [];
  try {
    checkClientChunkBudget(assets, (line: string) => lines.push(line));
    return { status: 0, stdout: lines.join('\n'), stderr: '', root };
  } catch (error) {
    return { status: 1, stdout: lines.join('\n'), stderr: String(error), root };
  }
}

it('rejects a large static closure even when every individual chunk passes', () => {
  const result = check({
    'index-entry.js': 'import "./first.js"; import "./second.js"; import "./third.js";',
    'first.js': `/*${'a'.repeat(600_000)}*/`,
    'second.js': `/*${'b'.repeat(600_000)}*/`,
    'third.js': `/*${'c'.repeat(600_000)}*/`,
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('startup static closure');
});

it.each(['file-viewer-lazy.js', 'diff-viewer-lazy.js'])(
  'rejects an eager viewer in the startup closure: %s',
  (viewer) => {
    const result = check({ 'index-entry.js': `import "./${viewer}";`, [viewer]: '' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must remain deferred');
  }
);

it('counts static imports and reexports once across shared and cyclic dependencies', () => {
  const result = check({
    'index-entry.js': 'import "./first.js"; export * from "./second.js";',
    'first.js': 'import "./shared.js";',
    'second.js': 'export { value } from "./shared.js";',
    'shared.js': 'import "./first.js"; export const value = 1;',
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('startup static closure: 4 JS files');
  expect(result.stdout).toContain('gzip bytes');
});

it('ignores dynamic imports, comments, and strings containing import text', () => {
  const result = check({
    'index-entry.js': `
      import('./file-viewer-lazy.js');
      // import './missing-comment.js';
      const example = "import './missing-string.js'";
    `,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('startup static closure: 1 JS files');
});

it('fails closed when a static dependency is missing from the build', () => {
  const result = check({ 'index-entry.js': 'export * from "./missing.js";' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('missing.js');
});

it.each([
  ['index-entry.js', 'file-viewer.tsx'],
  ['index-entry.js', 'diff-viewer.tsx'],
  ['shared.js', 'file-viewer.tsx'],
  ['shared.js', 'diff-viewer.tsx'],
])('rejects %s containing source module %s regardless of chunk naming', (chunk, viewer) => {
  const result = check(
    {
      'index-entry.js': chunk === 'shared.js' ? 'import "./shared.js";' : '',
      'shared.js': '',
    },
    {
      'index-entry.js':
        chunk === 'index-entry.js' ? [`src/client/features/workspace/${viewer}`] : [],
      'shared.js': chunk === 'shared.js' ? [`src/client/features/workspace/${viewer}`] : [],
    }
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(`${viewer} must remain deferred`);
});

it('allows viewer source modules in dynamically imported shared chunks', () => {
  const result = check(
    { 'index-entry.js': 'import("./shared.js");', 'shared.js': '' },
    { 'index-entry.js': [], 'shared.js': ['src/client/features/workspace/file-viewer.tsx'] }
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('startup static closure: 1 JS files');
});

it('fails closed without the source module manifest', () => {
  const result = check({}, null);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('client-modules.json');
});

it('fails closed when a static chunk has no source module metadata', () => {
  const result = check(
    { 'index-entry.js': 'import "./shared.js";', 'shared.js': '' },
    { 'index-entry.js': [] }
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Missing source module metadata for shared.js');
});

it('runs the CLI with its default asset directory and rejects invalid builds', () => {
  const { root } = check({});
  const run = () =>
    spawnSync(process.execPath, [resolve('scripts/check-client-chunk-budget.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });
  expect(run().status).toBe(0);
  writeFileSync(join(root, 'dist/client/assets/index-entry.js'), 'import "./file-viewer-lazy.js";');
  const failed = run();
  expect(failed.status).not.toBe(0);
  expect(failed.stderr).toContain('must remain deferred');
});
