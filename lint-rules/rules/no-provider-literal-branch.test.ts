import { describe, expect, it } from 'vitest';
import { describeRuleFixtures, readProjectConfig } from '../testing/rule-fixtures';

const RULE = 'factory/no-provider-literal-branch';
const scopes = readProjectConfig().overrides.filter(
  (override) => override.rules[RULE] !== undefined
);

describe('provider literal branches', () => {
  it('are rejected under src only', () => {
    expect(scopes.map((override) => [override.files, override.rules[RULE]])).toEqual([
      [['src/**/*.{ts,tsx}'], 'error'],
    ]);
  });
});

const at = (file: string, source: string) => ({ file, source });

// Fixture paths mirror the repository, and `files` applies the project's scope.
describeRuleFixtures('no-provider-literal-branch', {
  files: scopes.flatMap((override) => override.files),
  rejected: [
    at(
      'src/backend/routers/example.ts',
      "export const isClaude = (provider: string) => provider === 'CLAUDE';"
    ),
    at('src/backend/routers/codex.ts', "if (session.provider === 'CODEX') { run(); }"),
    at(
      'src/backend/routers/not-equal.ts',
      "export const other = (provider: string) => provider !== 'CODEX';"
    ),
    at(
      'src/backend/routers/loose.ts',
      "export const loose = (provider: string) => provider == 'CLAUDE';"
    ),
    at(
      'src/backend/routers/loose-not.ts',
      "export const loose = (provider: string) => provider != 'CLAUDE';"
    ),
    // The literal on the left, double quotes, and an expression-free template.
    at(
      'src/backend/routers/yoda.ts',
      "export const yoda = (provider: string) => 'CLAUDE' === provider;"
    ),
    at(
      'src/backend/routers/double.ts',
      'export const double = (provider: string) => provider === "CODEX";'
    ),
    at(
      'src/backend/routers/template.ts',
      'export const template = (provider: string) => provider === `CODEX`;'
    ),
    at(
      'src/backend/routers/switch-case.ts',
      "export function label(provider: string) {\n  switch (provider) {\n    case 'CLAUDE':\n      return 'Claude';\n    default:\n      return 'other';\n  }\n}"
    ),
    // A cast, `satisfies` or non-null assertion does not hide the literal.
    at(
      'src/backend/routers/cast.ts',
      "export const isClaude = (provider: string) => provider === ('CLAUDE' as SessionProvider);"
    ),
    at(
      'src/backend/routers/satisfies.ts',
      "export const isCodex = (provider: string) => 'CODEX' satisfies string === provider;"
    ),
    // Client and shared code are covered too.
    at(
      'src/client/features/example/label.ts',
      "export const isCodex = (provider: string) => provider === 'CODEX';"
    ),
    at(
      'src/shared/provider.ts',
      "export const isCodex = (provider: string) => provider === 'CODEX';"
    ),
    at('src/cli/provider.ts', "export const isCodex = (provider: string) => provider === 'CODEX';"),
    // A provider module's sibling is not the provider module.
    at(
      'src/backend/services/session/service/providers-extra/example.ts',
      "export const isCodex = (provider: string) => provider === 'CODEX';"
    ),
  ],
  accepted: [
    // The literals as values are not branching.
    at(
      'src/backend/routers/values.ts',
      "export const defaults = { provider: 'CLAUDE' };\nexport const choose = () => start('CODEX');\nexport type Provider = 'CLAUDE' | 'CODEX';\nexport const providers = ['CLAUDE', 'CODEX'] as const;"
    ),
    at(
      'src/backend/routers/zod.ts',
      "import { z } from 'zod';\nexport const schema = z.enum(['CLAUDE', 'CODEX']);\nexport const picked = z.literal('CLAUDE');"
    ),
    at(
      'src/backend/routers/prisma.ts',
      "export const where = { provider: 'CODEX' };\nexport const select = (provider: string) => ({ provider: provider ?? 'CLAUDE' });"
    ),
    at(
      'src/backend/routers/fallback.ts',
      "export const pick = (provider?: string) => provider ?? 'CLAUDE';\nexport const label = (ok: boolean) => (ok ? 'CLAUDE' : 'CODEX');"
    ),
    // Other literals, other operators and other operands.
    at(
      'src/backend/routers/other.ts',
      "export const status = (value: string) => value === 'RUNNING' || value === 'claude' || value === 'CLAUDE_CODE';\nexport const order = (value: string) => value < 'CODEX';"
    ),
    at(
      'src/backend/routers/non-literal.ts',
      'export const same = (a: string, b: string) => a === b;\nexport const withTemplate = (a: string, b: string) => a === `CLAUDE${b}`;'
    ),
    at(
      'src/backend/routers/switch-other.ts',
      "export function label(status: string) {\n  switch (status) {\n    case 'RUNNING':\n      return 'running';\n    default:\n      return 'other';\n  }\n}"
    ),
    at(
      'src/backend/routers/member.ts',
      "import { SessionProvider } from '@prisma-gen/client';\nexport const isClaude = (provider: SessionProvider) => provider === SessionProvider.CLAUDE;"
    ),
    // The provider module itself, in any depth.
    at(
      'src/backend/services/session/service/providers/provider-example.ts',
      "export const isClaude = (provider: string) => provider === 'CLAUDE';"
    ),
    at(
      'src/backend/services/session/service/providers/claude/nested.ts',
      "export function label(provider: string) {\n  switch (provider) {\n    case 'CODEX':\n      return 'Codex';\n    default:\n      return 'other';\n  }\n}"
    ),
    // Tests, stories and test support are exempt.
    at('src/backend/routers/example.test.ts', "expect(session.provider === 'CLAUDE').toBe(true);"),
    at(
      'src/backend/routers/example.integration.test.ts',
      "export const isClaude = (p: string) => p === 'CLAUDE';"
    ),
    at(
      'src/client/features/example/example.stories.tsx',
      "export const isCodex = (p: string) => p === 'CODEX';"
    ),
    at(
      'src/client/features/example/example.story-fixtures.ts',
      "export const isCodex = (p: string) => p === 'CODEX';"
    ),
    at(
      'src/backend/testing/provider-fixture.ts',
      "export const isCodex = (p: string) => p === 'CODEX';"
    ),
    at('src/test-utils/provider.ts', "export const isCodex = (p: string) => p === 'CODEX';"),
    at(
      'src/backend/orchestration/testing/provider.test-support.ts',
      "export const isCodex = (p: string) => p === 'CODEX';"
    ),
    // Outside src the rule is not enabled.
    at('scripts/provider.ts', "export const isCodex = (p: string) => p === 'CODEX';"),
  ],
});
