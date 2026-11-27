import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { configService } from '@/backend/services/config.service';
import { runDisposableInference } from './disposable-inference';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }));
vi.mock('@/backend/services/codex-accounts', () => ({
  getMetadataCredentialsStore: vi.fn(),
  codexAccountService: { getRuntimeContext: vi.fn() },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  configService.reload();
  mocks.query.mockReset();
});

/** The options of one Claude disposable inference under `env`, read by the real config service. */
async function claudeOptions(env: Record<string, string | undefined>) {
  vi.stubEnv('FF_SANDBOX_SCENARIO', undefined);
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  configService.reload();
  mocks.query.mockReturnValue({
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield { type: 'result', subtype: 'success', structured_output: { ok: true } };
    },
    close: vi.fn(),
  });
  await runDisposableInference(
    {
      label: 'Test',
      provider: 'CLAUDE',
      model: 'haiku',
      instructions: 'Answer.',
      prompt: '{}',
      schema: z.object({ ok: z.boolean() }),
      timeoutMs: 10_000,
    },
    new AbortController().signal
  );
  return mocks.query.mock.calls.at(-1)?.[0].options;
}

// The SDK and its bundled CLI are a version-locked pair: a user's own CLAUDE_CODE_EXECUTABLE must
// not replace the bundled CLI here. Only the dev sandbox, whose fake CLI speaks this SDK, may.
it("keeps the SDK's bundled CLI when CLAUDE_CODE_EXECUTABLE is set outside the sandbox", async () => {
  const options = await claudeOptions({ CLAUDE_CODE_EXECUTABLE: '/home/me/.local/bin/claude' });
  expect(options).not.toHaveProperty('pathToClaudeCodeExecutable');
});

it('runs the sandbox fake named by CLAUDE_CODE_EXECUTABLE in the dev sandbox', async () => {
  const options = await claudeOptions({
    CLAUDE_CODE_EXECUTABLE: '/sandbox/bin/claude',
    FF_SANDBOX_SCENARIO: 'echo',
  });
  expect(options).toMatchObject({ pathToClaudeCodeExecutable: '/sandbox/bin/claude' });
});
