import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  compareInventory,
  deriveConventions,
  evaluateInventory,
  locallyDeclaredExports,
  parseKnipOutput,
  parseUnusedCodeBaseline,
  pruneInventory,
  unusedCodeConventions,
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

it('detects all test-only production candidates, including fixture support', () => {
  const { root, write } = fixture();
  const files = [
    'src/test-only.ts',
    'src/shared/testing/recovery-json-storage.fixture.ts',
    'src/client/components/streamdown-markdown.fixtures.ts',
  ];
  for (const [index, file] of files.entries()) {
    write(file, 'export const abandoned = 1;');
    write(
      `src/test-only-${index}.test.ts`,
      `import { abandoned } from './${file.slice(4, -3)}'; console.log(abandoned);`
    );
  }
  expect(analyze(root, 'full-files')).toEqual([]);
  const production = analyze(root, 'production');
  const exports = analyze(root, 'exports');
  for (const [index, file] of files.entries()) {
    expect(production).toContain(file);
    expect(production).not.toContain(`src/test-only-${index}.test.ts`);
    expect(exports).not.toContain(`${file}::exports::abandoned`);
  }
}, 30_000);

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
  const baseline = parseUnusedCodeBaseline(inventory);
  const production = data.drift.production.added;
  expect(() => evaluateInventory(undefined, baseline, production, [])).toThrow(
    'New production candidate: src/abandoned.ts'
  );
  expect(() => evaluateInventory('--update', baseline, production, [])).toThrow('unreviewed');
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

it('renders matching inventories and prunes resolved entries in both modes', () => {
  const review = {
    disposition: 'review-required',
    reason: 'Review runtime ownership before deleting.',
  };
  const baseline = parseUnusedCodeBaseline({
    version: 1,
    production: { 'src/resolved.ts': review },
    exports: { 'src/resolved.ts::exports::old': review },
  });
  expect(() => evaluateInventory(undefined, baseline, [], [])).toThrow(
    'Stale production candidate: src/resolved.ts'
  );
  const updated = evaluateInventory('--update', baseline, [], []);
  expect(parseUnusedCodeBaseline(JSON.parse(updated.baseline ?? 'null'))).toEqual({
    version: 1,
    production: {},
    exports: {},
  });
  expect(updated.output).toContain('Pruned resolved');
  expect(
    evaluateInventory(
      undefined,
      parseUnusedCodeBaseline({ version: 1, production: {}, exports: {} }),
      [],
      []
    ).output
  ).toContain('inventory matches');
});

describe('location conventions', () => {
  const barrel = "export * from './service';\nexport { named } from './named';";
  const sources: Record<string, string> = {
    'src/backend/services/session/index.ts': barrel,
    'src/backend/services/session/service/index.ts': barrel,
    'src/client/features/chat/index.ts': barrel,
    'src/backend/services/periodic-task/index.ts': `import { local } from './local';
      export { local as aliased };
      export * from './types';
      export function chatReducer() {}
      const helper = 1;
      export { helper as exposedHelper };`,
  };
  const readSource = (file: string) => {
    const source = sources[file];
    if (source === undefined) {
      throw new Error(`Unexpected source read: ${file}`);
    }
    return source;
  };
  const conventionOf = (section: 'production' | 'exports', key: string) =>
    deriveConventions(section, [key], readSource).get(key)?.name ?? null;

  it.each([
    [
      'test-support directory',
      'production',
      'src/backend/testing/setup.ts',
      'src/backend/testing.ts',
    ],
    ['test-support directory', 'production', 'src/test-utils/deferred.ts', 'src/lib/test-utils.ts'],
    [
      'test-support file name',
      'production',
      'src/shared/pr-monitoring.test-helpers.ts',
      'src/shared/pr-monitoring-test-helpers.ts',
    ],
    [
      'test-support file name',
      'production',
      'electron/main/lifecycle.test-support.ts',
      'src/backend/test-support.ts',
    ],
    [
      'test-support file name',
      'production',
      'src/client/features/kanban/inline-workspace-form.test-harness.tsx',
      'src/client/features/kanban/inline-workspace-form.harness.tsx',
    ],
    [
      'test-support file name',
      'production',
      'src/client/features/agents/event-history.story-fixtures.ts',
      'src/client/features/agents/event-dashboard-story.tsx',
    ],
    [
      'test-support file name',
      'production',
      'src/lib/claude.fixture.ts',
      'src/client/components/streamdown-markdown.fixtures.ts',
    ],
    [
      'service capsule barrel re-export',
      'exports',
      'src/backend/services/session/index.ts::exports::fromWildcard',
      'src/backend/services/session/service/session.service.ts::exports::fromWildcard',
    ],
    [
      'service capsule barrel re-export',
      'exports',
      'src/backend/services/session/service/index.ts::types::named',
      'src/client/features/chat/index.ts::types::named',
    ],
    [
      'service capsule barrel re-export',
      'exports',
      'src/backend/services/periodic-task/index.ts::exports::aliased',
      'src/backend/services/periodic-task/index.ts::exports::chatReducer',
    ],
    [
      'service capsule barrel re-export',
      'exports',
      'src/backend/services/periodic-task/index.ts::exports::fromTypes',
      'src/backend/services/periodic-task/index.ts::exports::exposedHelper',
    ],
    [
      'shadcn component',
      'exports',
      'src/components/ui/card.tsx::exports::CardAction',
      'src/client/components/card.tsx::exports::CardAction',
    ],
  ] as const)('%s (%s) accepts %s and rejects %s', (name, section, accepted, rejected) => {
    expect(unusedCodeConventions.map((convention) => convention.name)).toContain(name);
    expect(conventionOf(section, accepted)).toBe(name);
    expect(conventionOf(section, rejected)).toBeNull();
  });

  it('never explains an unused barrel or component file in the production analysis', () => {
    expect(conventionOf('production', 'src/components/ui/card.tsx')).toBeNull();
    expect(conventionOf('production', 'src/backend/services/session/index.ts')).toBeNull();
  });

  it('explains test-support files but never their unused exports', () => {
    const helper =
      'src/backend/services/session/service/lifecycle/session-lifecycle.test-helpers.ts';
    expect(conventionOf('production', helper)).toBe('test-support file name');
    expect(conventionOf('exports', `${helper}::exports::helper`)).toBeNull();
    expect(conventionOf('production', 'src/test-utils/deferred.ts')).toBe('test-support directory');
    expect(conventionOf('exports', 'src/test-utils/deferred.ts::exports::deferred')).toBeNull();
  });

  it('covers only service capsule barrels, not deeper or non-service index files', () => {
    for (const key of [
      'src/backend/services/session/service/acp/index.ts::exports::fromWildcard',
      'src/backend/schemas/websocket/index.ts::exports::fromWildcard',
      'src/client/features/chat/agent-activity/tool-renderers/index.ts::exports::fromWildcard',
      'src/client/routes/admin/index.ts::exports::fromWildcard',
      'src/lib/diff/index.ts::exports::fromWildcard',
      'src/shared/core/index.ts::exports::fromWildcard',
    ]) {
      expect(conventionOf('exports', key)).toBeNull();
    }
  });

  it('distinguishes declared exports from re-exports in either syntax', () => {
    expect(
      locallyDeclaredExports(
        'src/a/index.ts',
        `import { imported } from './b';
        export { imported };
        export * from './c';
        export { renamed as alias } from './d';
        export const [first, { second }] = pair;
        export type Local = string;
        export interface Shape {}
        enum Hidden { A }
        export { Hidden as Visible };
        export default function main() {}`
      )
    ).toEqual(new Set(['first', 'second', 'Local', 'Shape', 'Visible', 'default']));
  });

  const empty = parseUnusedCodeBaseline({ version: 1, production: {}, exports: {} });

  const reviewed = z.object({
    review: z.object({ disposition: z.string(), reason: z.string() }).nullable(),
    convention: z.string().nullable(),
  });
  const reportSchema = z.object({
    production: z.array(reviewed.extend({ file: z.string() })),
    exports: z.array(reviewed.extend({ key: z.string() })),
  });
  const reviewFor = (name: string) =>
    unusedCodeConventions.find((convention) => convention.name === name)?.review;

  it('accepts conventional candidates without baseline entries and reports why', () => {
    const production = ['src/shared/pr-monitoring.test-helpers.ts', 'src/test-utils/deferred.ts'];
    const exports = [
      'src/backend/services/session/index.ts::exports::fromWildcard',
      'src/components/ui/card.tsx::exports::CardAction',
    ];
    const result = evaluateInventory(undefined, empty, production, exports, readSource);
    expect(result.output).toContain('2 production files (2 by convention)');
    expect(result.output).toContain('2 export visibility candidates (2 by convention)');
    const report = reportSchema.parse(
      JSON.parse(evaluateInventory('--report', empty, production, exports, readSource).output)
    );
    expect(report.production).toEqual([
      {
        file: production[0],
        convention: 'test-support file name',
        review: reviewFor('test-support file name'),
      },
      {
        file: production[1],
        convention: 'test-support directory',
        review: reviewFor('test-support directory'),
      },
    ]);
    expect(report.exports).toEqual([
      {
        key: exports[0],
        convention: 'service capsule barrel re-export',
        review: reviewFor('service capsule barrel re-export'),
      },
      { key: exports[1], convention: 'shadcn component', review: reviewFor('shadcn component') },
    ]);
  });

  it('still fails a genuinely unused production file outside the conventions', () => {
    expect(() =>
      evaluateInventory(
        undefined,
        empty,
        [
          'src/backend/lib/abandoned.ts',
          'src/lib/fixtures/claude.ts',
          'src/test-utils/deferred.ts',
        ],
        [],
        readSource
      )
    ).toThrow(
      /^New production candidate: src\/backend\/lib\/abandoned\.ts\nNew production candidate: src\/lib\/fixtures\/claude\.ts\nReview/u
    );
  });

  it('still fails a new unexplained export outside the service barrels and components', () => {
    expect(() =>
      evaluateInventory(
        undefined,
        empty,
        [],
        [
          'src/backend/lib/shell.ts::exports::newHelper',
          'src/backend/services/periodic-task/index.ts::exports::chatReducer',
          'src/backend/services/periodic-task/index.ts::types::FromTypes',
          'src/backend/services/session/service/lifecycle/session-lifecycle.test-helpers.ts::exports::unusedHelper',
          'src/client/features/chat/index.ts::exports::fromWildcard',
        ],
        readSource
      )
    ).toThrow(
      new RegExp(
        `^${[
          'src/backend/lib/shell.ts::exports::newHelper',
          'src/backend/services/periodic-task/index.ts::exports::chatReducer',
          'src/backend/services/session/service/lifecycle/session-lifecycle.test-helpers.ts::exports::unusedHelper',
          'src/client/features/chat/index.ts::exports::fromWildcard',
        ]
          .map((key) => `New exports candidate: ${key.replaceAll('.', '\\.')}\n`)
          .join('')}Review`,
        'u'
      )
    );
  });

  it('flags explicit entries a convention covers, keeps overrides, and update prunes them', () => {
    const baseline = parseUnusedCodeBaseline({
      version: 1,
      production: {
        'src/test-utils/deferred.ts': {
          disposition: 'test-support',
          reason: 'Duplicates the directory convention.',
        },
      },
      exports: {
        'src/components/ui/card.tsx::exports::CardAction': {
          disposition: 'review-required',
          reason: 'Confirm no story still renders this before trimming.',
        },
      },
    });
    const production = ['src/test-utils/deferred.ts'];
    const exports = ['src/components/ui/card.tsx::exports::CardAction'];
    expect(() => evaluateInventory(undefined, baseline, production, exports, readSource)).toThrow(
      /^Redundant production entry: src\/test-utils\/deferred\.ts \(covered by the 'test-support directory' convention\)\nReview/u
    );
    const report = reportSchema.parse(
      JSON.parse(evaluateInventory('--report', baseline, production, exports, readSource).output)
    );
    // The redundant entry still names its convention; the override does not.
    expect(report.production).toEqual([
      {
        file: production[0],
        review: baseline.production[production[0] ?? ''],
        convention: 'test-support directory',
      },
    ]);
    expect(report.exports).toEqual([
      { key: exports[0], review: baseline.exports[exports[0] ?? ''], convention: null },
    ]);
    const updated = parseUnusedCodeBaseline(
      JSON.parse(
        evaluateInventory('--update', baseline, production, exports, readSource).baseline ?? 'null'
      )
    );
    expect(updated).toEqual({ version: 1, production: {}, exports: baseline.exports });
    expect(evaluateInventory(undefined, updated, production, exports, readSource).output).toContain(
      'inventory matches'
    );
  });
});

it('lets a conventional test helper and service barrel re-export pass, and nothing else', () => {
  const { root, write } = fixture();
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  write(
    'scripts/unused-code-baseline.json',
    JSON.stringify({ version: 1, production: {}, exports: {} })
  );
  // Each test keeps `spare` used inside its module, so only a barrel's
  // re-export of it is a candidate.
  const barrelModule = (dir: string) => {
    write(`${dir}/index.ts`, "export { used, spare } from './implementation';");
    write(`${dir}/implementation.ts`, 'export const used = 1; export const spare = 2;');
    write(
      `${dir}/implementation.test.ts`,
      "import { spare } from './implementation'; console.log(spare);"
    );
  };
  barrelModule('src/backend/services/feature');
  write(
    'src/client/main.tsx',
    "import { used } from '../backend/services/feature'; console.log(used);"
  );
  write('src/client/feature/feature.test-helpers.ts', 'export const helper = 1;');
  write(
    'src/client/feature/feature.test.ts',
    "import { helper } from './feature.test-helpers'; console.log(helper);"
  );
  const run = () =>
    spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/check-unused-code.ts')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
  const accepted = run();
  expect(accepted.stderr).toBe('');
  expect(accepted.stdout).toContain('1 production files (1 by convention)');
  expect(accepted.stdout).toContain('1 export visibility candidates (1 by convention)');

  barrelModule('src/client/feature');
  write(
    'src/client/main.tsx',
    "import { used } from '../backend/services/feature'; import { used as alsoUsed } from './feature'; import './local'; console.log(used, alsoUsed);"
  );
  write('src/client/local.ts', 'export const unexplained = 1;');
  write(
    'src/client/feature/feature.test-helpers.ts',
    'export const helper = 1; export const unusedHelper = 2;'
  );
  write('src/lib/fixtures/sample.ts', 'export const sample = 1;');
  write(
    'src/lib/sample.test.ts',
    "import { sample } from './fixtures/sample'; console.log(sample);"
  );
  const rejected = run();
  expect(rejected.status).toBe(1);
  for (const violation of [
    'New production candidate: src/lib/fixtures/sample.ts',
    'New exports candidate: src/client/feature/index.ts::exports::spare',
    'New exports candidate: src/client/feature/feature.test-helpers.ts::exports::unusedHelper',
    'New exports candidate: src/client/local.ts::exports::unexplained',
  ]) {
    expect(rejected.stderr).toContain(violation);
  }
  expect(rejected.stderr).not.toContain('src/backend/services/feature/index.ts');
  expect(rejected.stderr).not.toContain('New production candidate: src/client/feature');
}, 60_000);

it('rejects unsupported evaluator modes at the runtime boundary', () => {
  const baseline = parseUnusedCodeBaseline({ version: 1, production: {}, exports: {} });
  expect(() => Reflect.apply(evaluateInventory, undefined, ['--typo', baseline, [], []])).toThrow();
});
