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

const BOARD_ROUTE = 'src/client/routes/projects/workspaces/list.tsx';

function check(
  chunks: Record<string, string>,
  sourceModules?: Record<string, string[]> | null,
  packages: Record<string, string[]> = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'ff-client-budget-'));
  directories.push(root);
  const assets = join(root, 'dist/client/assets');
  mkdirSync(assets, { recursive: true });
  const files = {
    'index-entry.js': 'import("./list-board.js");',
    'file-viewer-lazy.js': '',
    'diff-highlight.worker-lazy.js': '',
    'list-board.js': '',
    ...chunks,
  };
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(assets, name), source);
  }
  if (sourceModules !== null) {
    // Every fixture has a board route chunk unless the test names its modules.
    const modules = {
      ...(sourceModules ?? Object.fromEntries(Object.keys(files).map((name) => [name, []]))),
      'list-board.js': sourceModules?.['list-board.js'] ?? [BOARD_ROUTE],
    };
    writeFileSync(
      join(assets, 'client-modules.json'),
      JSON.stringify({
        version: 2,
        modules,
        packages: Object.fromEntries(
          Object.keys(modules).map((name) => [name, packages[name] ?? []])
        ),
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

it('measures uncompressed chunks and ignores precompressed siblings', () => {
  const entry = `/*${'a'.repeat(700_000)}*/`;
  const result = check({
    'index-entry.js': entry,
    'index-entry.js.br': 'small',
    'index-entry.js.gz': 'small',
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('index-entry.js: 700004 bytes exceeds the 650000 byte budget');
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

it.each([
  'streamdown',
  'react-markdown',
  'micromark',
  'micromark-util-symbol',
  'remark-gfm',
  'rehype-raw',
  'unified',
  'mdast-util-to-hast',
])('rejects the markdown package %s in the board route static closure', (markdownPackage) => {
  const result = check({ 'list-board.js': 'import "./shared.js";', 'shared.js': '' }, undefined, {
    'shared.js': ['@phosphor-icons/react', markdownPackage],
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    `shared.js: board route static closure must not contain ${markdownPackage}`
  );
});

it('allows markdown packages behind a dynamic import from the board route', () => {
  const result = check(
    { 'list-board.js': 'import("./quick-chat.js");', 'quick-chat.js': '' },
    undefined,
    { 'quick-chat.js': ['streamdown', 'micromark'] }
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('board route static closure: 1 JS files beyond startup');
});

it('rejects a board route static closure over its budget', () => {
  const result = check({
    'list-board.js': 'import "./board-only.js";',
    'board-only.js': `/*${'a'.repeat(900_000)}*/`,
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(
    /board route static closure: \d+ bytes exceeds the \d+ byte budget/
  );
});

it('counts only board route files that startup does not already load', () => {
  const shared = `/*${'a'.repeat(900_000)}*/`;
  const result = check({
    'index-entry.js': 'import "./shared.js"; import("./list-board.js");',
    'list-board.js': 'import "./shared.js";',
    'shared.js': shared,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('board route static closure: 1 JS files beyond startup');
});

it('fails closed when no chunk contains the board route', () => {
  const result = check({}, { 'index-entry.js': [], 'list-board.js': [] });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(`Expected exactly one chunk containing ${BOARD_ROUTE}`);
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
