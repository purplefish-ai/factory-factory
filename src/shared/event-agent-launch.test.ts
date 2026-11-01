import { expect, it } from 'vitest';
import {
  eventAgentExecutionSchema,
  eventSessionCreationSchema,
  eventWorkspaceIdentitySchema,
} from './event-agent-launch';

const claude = {
  version: 1 as const,
  provider: 'CLAUDE' as const,
  model: 'sonnet',
  reasoningEffort: 'high',
  codexAccountId: null,
  startupModePreset: 'non_interactive' as const,
  accessMode: 'bypassPermissions',
  planModeEnabled: false as const,
};
const codex = {
  ...claude,
  provider: 'CODEX' as const,
  model: 'gpt-5.4',
  codexAccountId: 'account',
  accessMode: 'workspace-write',
};
it.each(['gpt-5.4', 'o3', 'o4-mini'])('rejects the Codex model %s for Claude', (model) => {
  expect(eventAgentExecutionSchema.safeParse({ ...claude, model }).success).toBe(false);
});
it.each(['sonnet', 'claude-sonnet-4', 'opus[1m]'])(
  'rejects the Claude model %s for Codex',
  (model) => {
    expect(eventAgentExecutionSchema.safeParse({ ...codex, model }).success).toBe(false);
  }
);
it.each([claude, codex])(
  'preserves custom model names for $provider without rewriting frozen intent',
  (intent) => {
    expect(
      eventAgentExecutionSchema.parse({ ...intent, model: 'custom-internal-v2' })
    ).toMatchObject({ model: 'custom-internal-v2' });
  }
);
it.each([' ', '\t', ' padded', 'padded '])(
  'rejects blank/padded reserved identifiers %j without normalization',
  (invalid) => {
    for (const field of ['id', 'workspaceId', 'runId']) {
      expect(
        eventSessionCreationSchema.safeParse({
          id: 'session',
          workspaceId: 'workspace',
          runId: 'run',
          execution: claude,
          [field]: invalid,
        }).success
      ).toBe(false);
    }
    for (const field of ['runId', 'reservedSessionId', 'initialMessageId']) {
      expect(
        eventWorkspaceIdentitySchema.safeParse({
          version: 1,
          runId: 'run',
          reservedSessionId: 'session',
          initialMessageId: 'message',
          [field]: invalid,
        }).success
      ).toBe(false);
    }
    for (const field of ['model', 'reasoningEffort', 'codexAccountId', 'accessMode']) {
      expect(eventAgentExecutionSchema.safeParse({ ...codex, [field]: invalid }).success).toBe(
        false
      );
    }
  }
);
