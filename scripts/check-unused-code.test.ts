import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  compareInventory,
  parseKnipOutput,
  parseUnusedCodeBaseline,
  pruneInventory,
} from './check-unused-code';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const config = z
  .object({
    workspaces: z.object({
      '.': z.object({ entry: z.array(z.string()), project: z.array(z.string()) }),
    }),
    ignoreExportsUsedInFile: z.boolean(),
  })
  .parse(JSON.parse(readFileSync(resolve('knip.json'), 'utf8')));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ff-unused-code-'));
  roots.push(root);
  function write(file: string, source: string) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  write('package.json', JSON.stringify({ name: 'fixture', private: true, type: 'module' }));
  write(
    'knip.json',
    JSON.stringify({
      entry: config.workspaces['.'].entry,
      project: config.workspaces['.'].project,
      ignoreExportsUsedInFile: config.ignoreExportsUsedInFile,
      vitest: { entry: ['src/**/*.test.ts'] },
    })
  );
  // Use the real configured production roots. No implicit index fallback can
  // keep the standalone CLI, Electron, MCP or browser worker dependencies alive.
  for (const entry of config.workspaces['.'].entry) {
    write(entry.replace(/!$/, ''), 'export {};');
  }
  return { root, write };
}

function analyze(root: string, mode: 'production' | 'exports' | 'full-files') {
  const result = spawnSync(
    process.execPath,
    [
      resolve('node_modules/knip/bin/knip.js'),
      '--config',
      'knip.json',
      '--no-progress',
      '--no-config-hints',
      '--include',
      mode === 'exports' ? 'exports,types' : 'files',
      '--reporter',
      'json',
      ...(mode === 'production' ? ['--production'] : []),
    ],
    { cwd: root, encoding: 'utf8', timeout: 30_000 }
  );
  return parseKnipOutput(result, mode === 'exports' ? 'exports' : 'production');
}

it.each([
  'src/test-only.ts',
  'src/shared/testing/recovery-json-storage.fixture.ts',
  'src/client/components/streamdown-markdown.fixtures.ts',
])('detects test-only production candidates, including fixture support: %s', (file) => {
  const { root, write } = fixture();
  write(file, 'export const abandoned = 1;');
  write(
    'src/test-only.test.ts',
    `import { abandoned } from './${file.slice(4, -3)}'; console.log(abandoned);`
  );
  expect(analyze(root, 'full-files')).toEqual([]);
  const production = analyze(root, 'production');
  expect(production).toContain(file);
  expect(production).not.toContain('src/test-only.test.ts');
  expect(analyze(root, 'exports')).not.toContain(`${file}::exports::abandoned`);
});

it('keeps each configured runtime and a lazy frontend dependency reachable', () => {
  const { root, write } = fixture();
  expect(config.workspaces['.'].entry).toEqual(
    expect.arrayContaining([
      'src/cli/index.ts!',
      'electron/main/index.ts!',
      'electron/preload/index.cts!',
      'src/backend/electron-utility-entry.ts!',
      'src/backend/mcp/workspace-mcp-server.ts!',
      'src/client/main.tsx!',
      'src/client/features/workspace/diff-highlight.worker.ts!',
    ])
  );
  for (const [index, entry] of config.workspaces['.'].entry.entries()) {
    const file = entry.replace(/!$/, '');
    const dependency = `src/runtime-${index}.ts`;
    expect(readFileSync(resolve(file), 'utf8').length).toBeGreaterThan(0);
    write(dependency, 'console.log("runtime");');
    const relativeImport = `${'../'.repeat(file.split('/').length - 1)}${dependency}`;
    write(file, `import '${relativeImport}';`);
  }
  write(
    'src/client/main.tsx',
    `${readFileSync(join(root, 'src/client/main.tsx'), 'utf8')}\nimport('./lazy-view');`
  );
  write('src/client/lazy-view.ts', 'console.log("lazy");');
  expect(analyze(root, 'production')).toEqual([]);
});

it('reports export visibility separately, retains barrels and ignores same-file use', () => {
  const { root, write } = fixture();
  write(
    'src/client/main.tsx',
    "import { used } from './feature'; import './local'; console.log(used);"
  );
  write('src/client/local.ts', 'export const sameFile = 1; console.log(sameFile);');
  write(
    'src/client/feature/index.ts',
    "export { used, unusedApi, type UnusedType } from './implementation';"
  );
  write(
    'src/client/feature/implementation.ts',
    `
    export const used = 1;
    export const unusedApi = 2;
    export type UnusedType = string;
    const local = 3;
    console.log(local);
  `
  );
  const exports = analyze(root, 'exports');
  expect(exports).toContain('src/client/feature/index.ts::exports::unusedApi');
  expect(exports).toContain('src/client/feature/index.ts::types::UnusedType');
  expect(exports).not.toContain('src/client/feature/implementation.ts::exports::used');
  expect(exports).not.toContain('src/client/local.ts::exports::sameFile');
  expect(analyze(root, 'production')).toEqual([]);
});

it('keeps known live previews, lazy viewers and critical runtime modules out of the repository report', () => {
  const candidates = analyze(resolve('.'), 'production');
  for (const file of [
    'src/client/components/github-issue-link.tsx',
    'src/client/components/github-pr-link.tsx',
    'src/client/components/markdown.tsx',
    'src/client/features/workspace/file-viewer.tsx',
    'src/client/features/workspace/diff-viewer.tsx',
    'src/client/features/workspace/diff-highlight.worker.ts',
    'src/backend/services/session/service/acp/acp-runtime-manager.ts',
    'src/backend/electron-utility-entry.ts',
    'src/backend/mcp/workspace-mcp-server.ts',
    'src/cli/index.ts',
    'electron/main/index.ts',
    'electron/preload/index.cts',
  ]) {
    expect(readFileSync(resolve(file), 'utf8').length).toBeGreaterThan(0);
    expect(candidates).not.toContain(file);
  }
}, 30_000);

describe('validated analyzer and inventory boundaries', () => {
  it.each([
    { status: 2, stdout: '{"issues":[]}', stderr: 'failure' },
    { status: 1, stdout: '{"issues":[]}', stderr: 'failure' },
    { status: 0, stdout: 'not JSON', stderr: '' },
    { status: 0, stdout: '{}', stderr: '' },
    {
      status: 0,
      stdout: '{"issues":[{"file":"../escape.ts","files":[{"name":"escape"}]}]}',
      stderr: '',
    },
    { status: 0, stdout: '{"issues":[{"file":"src/a.ts","files":"changed schema"}]}', stderr: '' },
    { status: null, stdout: '', stderr: '', signal: 'SIGTERM' },
    { status: null, stdout: '', stderr: '', error: new Error('timeout') },
  ])('fails closed on failed or malformed analysis: %j', (result) => {
    expect(() => parseKnipOutput(result, 'production')).toThrow();
  });

  it('ignores positions when creating stable export keys', () => {
    const result = (line: number) =>
      parseKnipOutput(
        {
          status: 1,
          stderr: '',
          stdout: JSON.stringify({
            issues: [
              {
                file: 'src/a.ts',
                exports: [{ name: 'value', line, col: 1, pos: line }],
                types: [],
              },
            ],
          }),
        },
        'exports'
      );
    expect(result(1)).toEqual(result(40));
  });

  it('rejects unknown baseline versions, unsafe keys and undocumented entries', () => {
    for (const baseline of [
      { version: 2, production: {}, exports: {} },
      {
        version: 1,
        production: { '../a.ts': { disposition: 'test-support', reason: 'kept' } },
        exports: {},
      },
      { version: 1, production: { 'src/a.ts': {} }, exports: {} },
    ]) {
      expect(() => parseUnusedCodeBaseline(baseline)).toThrow();
    }
  });

  it('flags new and stale keys and only prunes resolved debt', () => {
    const reviewed = {
      disposition: 'review-required',
      reason: 'Assess runtime ownership before deleting.',
    };
    const baseline = parseUnusedCodeBaseline({
      version: 1,
      production: {
        'src/old.ts': reviewed,
        'src/retained.ts': reviewed,
      },
      exports: {},
    });
    expect(compareInventory(['src/new.ts', 'src/retained.ts'], baseline.production)).toEqual({
      added: ['src/new.ts'],
      stale: ['src/old.ts'],
    });
    expect(() => pruneInventory(['src/new.ts'], baseline.production)).toThrow('unreviewed');
    expect(pruneInventory(['src/retained.ts'], baseline.production)).toEqual({
      'src/retained.ts': reviewed,
    });
  });
});

it('reports new candidates without accepting them, and update cannot add debt', () => {
  const { root, write } = fixture();
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  const inventory = { version: 1, production: {}, exports: {} };
  write('scripts/unused-code-baseline.json', JSON.stringify(inventory));
  write('src/abandoned.ts', 'export const value = 1;');
  write('src/abandoned.test.ts', "import { value } from './abandoned'; console.log(value);");
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('scripts/check-unused-code.ts'), ...args],
      { cwd: root, encoding: 'utf8', timeout: 30_000 }
    );
  const report = run(['--report']);
  expect(report.status).toBe(0);
  const data = z
    .object({ drift: z.object({ production: z.object({ added: z.array(z.string()) }) }) })
    .parse(JSON.parse(report.stdout));
  expect(data.drift.production.added).toEqual(['src/abandoned.ts']);
  const normal = run([]);
  expect(normal.status).toBe(1);
  expect(normal.stderr).toContain('New production candidate: src/abandoned.ts');
  const update = run(['--update']);
  expect(update.status).toBe(1);
  expect(update.stderr).toContain('unreviewed');
  expect(JSON.parse(readFileSync(join(root, 'scripts/unused-code-baseline.json'), 'utf8'))).toEqual(
    inventory
  );
  expect(run(['--unknown']).status).toBe(1);
}, 30_000);
