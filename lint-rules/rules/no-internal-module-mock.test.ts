import { describe, expect, it } from 'vitest';
import { describeRuleFixtures, readProjectConfig } from '../testing/rule-fixtures';

const RULE = 'factory/no-internal-module-mock';
const scopes = readProjectConfig().overrides.filter(
  (override) => override.rules[RULE] !== undefined
);

describe('internal module mocks', () => {
  it('are rejected in test files under src only', () => {
    expect(scopes.map((override) => [override.files, override.rules[RULE]])).toEqual([
      [['src/**/*.test.ts', 'src/**/*.test.tsx'], 'error'],
    ]);
  });
});

// Fixture paths mirror the repository, so the rule sees where each test lives,
// and `files` applies the project's scope, so a non-test file is not linted.
describeRuleFixtures('no-internal-module-mock', {
  files: scopes.flatMap((override) => override.files),
  rejected: [
    // Internal module by alias, from outside the capsule.
    {
      file: 'src/backend/orchestration/example.test.ts',
      source: "vi.mock('@/backend/services/session/service/lifecycle/session.service');",
    },
    // Internal module by relative path.
    {
      file: 'src/backend/orchestration/relative.test.ts',
      source: "vi.mock('../services/workspace/resources/workspace.accessor', () => ({}));",
    },
    // An inner barrel is internal: only the capsule's index.ts is public.
    {
      file: 'src/backend/orchestration/inner.test.ts',
      source: "vi.mock('@/backend/services/session/service');",
    },
    {
      file: 'src/backend/orchestration/do-mock.test.ts',
      source:
        "vi.doMock('@/backend/services/run-script/service/run-script-process-utils', () => ({}));",
    },
    {
      file: 'src/backend/orchestration/template.test.ts',
      source: 'vi.mock(`@/backend/services/session/service/lifecycle/session.service`);',
    },
    // A test inside one capsule mocking another capsule's internals.
    {
      file: 'src/backend/services/session/cross-capsule.test.ts',
      source: "vi.mock('@/backend/services/workspace/resources/workspace.accessor');",
    },
    // A root infrastructure test is outside every capsule.
    {
      file: 'src/backend/services/logger.example.test.ts',
      source: "vi.mock('./session/service/lifecycle/session.service');",
    },
    {
      file: 'src/backend/orchestration/example.integration.test.ts',
      source: "vi.mock('@/backend/services/settings/resources/user-settings.accessor');",
    },
    {
      file: 'src/client/example.test.tsx',
      source: "vi.mock('@/backend/services/settings/resources/user-settings.accessor');",
    },
    // Only the `testing/` directory itself is a public test surface.
    {
      file: 'src/backend/orchestration/testing-lookalike.test.ts',
      source: "vi.mock('@/backend/services/session/testing-helpers');",
    },
  ],
  accepted: [
    // The capsule barrel, by alias, by `/index` and by relative path.
    {
      file: 'src/backend/orchestration/barrel.test.ts',
      source: "vi.mock('@/backend/services/session');",
    },
    {
      file: 'src/backend/orchestration/barrel-index.test.ts',
      source: "vi.mock('@/backend/services/session/index');",
    },
    {
      file: 'src/backend/orchestration/barrel-relative.test.ts',
      source: "vi.mock('../services/workspace'); vi.mock('../services/workspace/index');",
    },
    // The owning capsule's own tests may mock its internals.
    {
      file: 'src/backend/services/session/service/example.test.ts',
      source:
        "vi.mock('@/backend/services/session/service/lifecycle/session.service'); vi.mock('./lifecycle/session.service');",
    },
    // Root infrastructure services are not capsules.
    {
      file: 'src/backend/orchestration/root.test.ts',
      source:
        "vi.mock('@/backend/services/logger.service'); vi.mock('../services/config.service');",
    },
    // A directory without an index.ts is not a capsule.
    {
      file: 'src/backend/orchestration/no-capsule.test.ts',
      source: "vi.mock('@/backend/services/not-a-capsule/thing');",
    },
    // A capsule's testing/ directory is public.
    {
      file: 'src/backend/orchestration/testing.test.ts',
      source:
        "vi.mock('@/backend/services/session/testing/fake-session'); vi.doMock('../services/agent-definition/testing');",
    },
    // Only literal targets are checked.
    {
      file: 'src/backend/orchestration/dynamic.test.ts',
      source:
        "vi.mock(modulePath); vi.mock(`@/backend/services/session/service/${name}`); other.mock('@/backend/services/session/service');",
    },
    {
      file: 'src/backend/orchestration/outside.test.ts',
      source: "vi.mock('@/backend/orchestration/example'); vi.mock('node:fs');",
    },
    // Test helpers that are not test files are outside the rule's scope.
    {
      file: 'src/backend/orchestration/example.test-harness.ts',
      source: "vi.mock('@/backend/services/session/service/lifecycle/session.service');",
    },
  ],
});
