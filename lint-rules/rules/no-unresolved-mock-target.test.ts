import { describe, expect, it } from 'vitest';
import plugin from '../factory.mjs';
import { describeRuleFixtures, readProjectConfig } from '../testing/rule-fixtures';

const RULE = 'factory/no-unresolved-mock-target';
const scopes = readProjectConfig().overrides.filter(
  (override) => override.rules[RULE] !== undefined
);
const files = scopes.flatMap((override) => override.files);

describe('unresolved mock targets', () => {
  it('are rejected in test files and test support under the source directories', () => {
    expect(scopes.map((override) => override.rules[RULE])).toEqual(['error']);
    expect(files).toEqual([
      '{src,scripts,electron,lint-rules}/**/*.{test,test-helpers,test-support,test-harness}.*',
      '{src,scripts,electron,lint-rules}/**/{testing,test-utils}/**',
    ]);
  });

  it('names the target and says the mock replaces nothing', () => {
    const reports: { node: unknown; message: string }[] = [];
    const specifier = { type: 'Literal', value: '@/backend/services/config.service-old' };
    const visitor = plugin.rules['no-unresolved-mock-target'].create({
      filename: '/tmp/example.test.ts',
      report: (report: { node: unknown; message: string }) => reports.push(report),
    });
    visitor.CallExpression({
      type: 'CallExpression',
      callee: {
        type: 'MemberExpression',
        computed: false,
        object: { type: 'Identifier', name: 'vi' },
        property: { type: 'Identifier', name: 'mock' },
      },
      arguments: [specifier],
    });
    expect(reports).toEqual([
      {
        node: specifier,
        message:
          "`@/backend/services/config.service-old` does not resolve to a module, so this mock replaces nothing. Point it at the module's current path.",
      },
    ]);
  });
});

// Fixtures run from a temporary directory that mirrors the repository layout.
// `@/`, `@prisma-gen/` and `/src/` resolve against the real repository, so those
// fixtures name modules that exist today and that no restructuring should move
// (a root service, a capsule barrel, the Prisma client, a stylesheet). A relative
// specifier resolves against the fixture's own directory, so the fixtures that
// exercise it write the module they mock beside the test.
const MODULE = 'export {};';
const sibling = (file: string, source = MODULE) => ({ file: `src/fixture/${file}`, source });
const test = (name: string, source: string) => ({ file: `src/fixture/${name}.test.ts`, source });

describeRuleFixtures('no-unresolved-mock-target', {
  files,
  rejected: [
    // The motivating case: a module that moved out from under a capsule's test.
    {
      file: 'src/backend/services/session/service/lifecycle/moved.test.ts',
      source: "vi.mock('@/backend/services/session/service/lifecycle/moved-away');",
    },
    {
      file: 'src/backend/services/session/service/lifecycle/moved-relative.test.ts',
      source: "vi.mock('./moved-away', () => ({}));",
    },
    // An alias path with no module behind it, with and without a factory.
    test('alias', "vi.mock('@/backend/services/config.service-old');"),
    test('alias-factory', "vi.mock('@/backend/services/config.service-old', () => ({}));"),
    test('do-mock', "vi.doMock('@/backend/services/config.service-old', () => ({}));"),
    test('template', 'vi.mock(`@/backend/services/config.service-old`);'),
    test('root-relative', "vi.mock('/src/backend/services/config.service-old');"),
    test('prisma', "vi.mock('@prisma-gen/missing');"),
    test('relative', "vi.mock('./not-here');"),
    test('parent-relative', "vi.mock('../fixture/not-here');"),
    test('parent-directory', "vi.mock('../../not-here');"),
    // A file that exists under another name does not make the path resolve.
    test('wrong-extension', "vi.mock('./target.png');"),
    test('wrong-alias-extension', "vi.mock('@/backend/services/config.service.png');"),
    // A directory resolves only through an index file with a source extension.
    test('directory-without-index', "vi.mock('./no-index');"),
    // A `.js` specifier needs a `.ts` or `.tsx` file of the same name.
    test('js-without-source', "vi.mock('./no-source.js');"),
  ],
  accepted: [
    // The path as a file, and with each source extension appended.
    sibling('target.ts'),
    sibling('view.tsx'),
    sibling('module.mts'),
    sibling('common.cts'),
    sibling('plain.js'),
    sibling('jsx-view.jsx'),
    sibling('esm.mjs'),
    sibling('legacy.cjs', 'module.exports = {};'),
    test(
      'extensions',
      "vi.mock('./target'); vi.mock('./view'); vi.mock('./module'); vi.mock('./common'); vi.mock('./plain'); vi.mock('./jsx-view'); vi.mock('./esm'); vi.mock('./legacy');"
    ),
    test(
      'with-extension',
      "vi.mock('./target.ts'); vi.mock('./plain.js'); vi.mock('./legacy.cjs');"
    ),
    // A directory with an index file in any source extension.
    sibling('with-index/index.ts'),
    sibling('with-index-tsx/index.tsx'),
    sibling('no-index/other.ts'),
    test(
      'directory-index',
      "vi.mock('./with-index'); vi.mock('./with-index/'); vi.mock('./with-index/index'); vi.mock('./with-index-tsx'); vi.mock('.');"
    ),
    // `..` names the parent directory's index.
    sibling('index.ts'),
    sibling('child/leaf.test.ts', "vi.mock('..'); vi.mock('../');"),
    // A `.js` specifier resolves to the `.ts` or `.tsx` file of the same name.
    test('js-to-ts', "vi.mock('./target.js'); vi.mock('./view.js');"),
    // Aliases resolve against the real repository, from any depth.
    {
      file: 'src/backend/orchestration/deep/er/alias.test.ts',
      source:
        "vi.mock('@/backend/services/config.service'); vi.mock('@/backend/services/config.service.ts'); vi.mock('@/backend/services/config.service.js'); vi.mock('/src/backend/services/config.service'); vi.mock('@prisma-gen/client');",
    },
    // A directory resolves through its index file.
    {
      file: 'src/backend/orchestration/barrel.test.ts',
      source:
        "vi.mock('@/backend/services/workspace'); vi.mock('@/backend/services/workspace/'); vi.mock('@/backend/services/workspace/index');",
    },
    // JSON and CSS resolve by appended extension or by their full name. Oxlint
    // lints only source files, so these name real files in the repository.
    {
      file: 'src/backend/orchestration/assets.test.ts',
      source:
        "vi.mock('@/client/globals'); vi.mock('@/client/globals.css'); vi.mock('@/backend/testing/fixtures/published-v6'); vi.mock('@/backend/testing/fixtures/published-v6.json');",
    },
    // Test support, not only test files, is checked; a real target passes.
    {
      file: 'src/backend/example.test-harness.ts',
      source: "vi.mock('@/backend/services/config.service');",
    },
    // A factory does not change what resolves: an existing target stays accepted.
    test(
      'factory',
      "vi.mock('./target', () => ({ value: 1 })); vi.mock('./view', async () => ({}));"
    ),
    // Package and Node specifiers are not repository paths.
    test(
      'packages',
      "vi.mock('node:fs'); vi.mock('fs'); vi.mock('react'); vi.mock('@scope/missing-package'); vi.mock('@trpc/server/adapters/express'); vi.mock('src/backend/missing'); vi.mock('#internal');"
    ),
    // Only literal targets are checked.
    test(
      'dynamic',
      "vi.mock(modulePath); vi.mock(`./missing-${name}`); vi.mock(`@/backend/services/${name}`); vi.mock(); other.mock('./missing'); vi.unmock('./missing');"
    ),
  ],
});
