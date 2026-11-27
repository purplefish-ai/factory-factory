import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import plugin from '../factory.mjs';
import { describeRuleFixtures, readProjectConfig, repositoryRoot } from '../testing/rule-fixtures';

const RULE = 'factory/no-mock-test-subject';
const files = ['{src,scripts,lint-rules}/**/*.test.{ts,tsx}'];

describe('test subject mocks', () => {
  it('rejects subject replacements in test files', () => {
    const scopes = readProjectConfig().overrides.filter(
      (override) => override.rules[RULE] !== undefined
    );
    expect(scopes.map((override) => [override.files, override.rules[RULE]])).toEqual([
      [files, 'error'],
    ]);
  });

  it.each([
    ['src/client/lib/cli-health-cache.test.ts', '@/client/lib/cli-health-cache'],
    ['src/backend/testing/fixtures/published-v6.test.ts', './published-v6'],
    ['src/backend/testing/fixtures/published-v6.test.ts', './published-v6.json'],
  ])('recognizes the subject in %s through %s', (filename, value) => {
    const reports: unknown[] = [];
    const visitor = plugin.rules['no-mock-test-subject'].create({
      filename: join(repositoryRoot, filename),
      report: (message: unknown) => reports.push(message),
    });
    const target = { type: 'Literal', value };
    visitor.CallExpression?.({
      type: 'CallExpression',
      callee: {
        type: 'MemberExpression',
        computed: false,
        object: { type: 'Identifier', name: 'vi' },
        property: { type: 'Identifier', name: 'mock' },
      },
      arguments: [target],
    });
    expect(reports).toEqual([
      {
        node: target,
        message: 'Use the real module under test. Mock a dependency at its public boundary.',
      },
    ]);
  });
});

describeRuleFixtures('no-mock-test-subject', {
  files,
  rejected: [
    { file: 'src/cache.test.ts', source: "vi.mock('./cache');" },
    {
      file: 'src/cache.integration.test.ts',
      source: "vi.doMock('./cache.js', () => ({}));",
    },
    {
      file: 'src/view.test.tsx',
      source: "vi.mock(import('./view.tsx'), () => ({}));",
    },
    { file: 'lint-rules/start.test.ts', source: 'vi.mock(`./start`);' },
    { file: 'scripts/run.test.ts', source: "vi.mock('./run.mjs', { spy: false });" },
    { file: 'src/nested/index.test.ts', source: "vi.mock('./');" },
  ],
  accepted: [
    { file: 'src/cache.ts', source: 'export const cache = new Map();' },
    { file: 'src/view.tsx', source: 'export const view = null;' },
    { file: 'scripts/run.mts', source: 'export const run = true;' },
    { file: 'lint-rules/start.ts', source: 'export const start = true;' },
    { file: 'src/nested/index.ts', source: 'export const subject = true;' },
    { file: 'src/cache.test.tsx', source: "vi.mock('./cache-storage');" },
    { file: 'src/sub/cache.test.ts', source: "vi.mock('../cache');" },
    { file: 'src/view.test.ts', source: "vi.mock(import('./view'), { spy: true });" },
    { file: 'src/observer.test.ts', source: "vi.spyOn(observer, 'read');" },
    { file: 'src/run.test.ts', source: "other.mock('./run');" },
    { file: 'src/dynamic.test.ts', source: 'vi.mock(path);' },
    { file: 'src/missing.test.ts', source: "vi.mock('./missing');" },
    { file: 'src/helpers.ts', source: "vi.mock('./helpers');" },
  ],
});
