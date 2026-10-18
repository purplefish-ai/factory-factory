import { describe, expect, it } from 'vitest';
import { AcpRuntimeManager } from './acp-runtime-manager';

const RUN_REAL_CODEX_APP_SERVER_TESTS = process.env.RUN_REAL_CODEX_APP_SERVER_TESTS === '1';
const RUN_REAL_PROMPT_TESTS = process.env.RUN_REAL_CODEX_APP_SERVER_PROMPT_TESTS === '1';
const describeIfRealCodex = RUN_REAL_CODEX_APP_SERVER_TESTS ? describe : describe.skip;

describeIfRealCodex('AcpRuntimeManager (manual real codex app-server)', () => {
  it('completes the upstream handshake and an explicitly enabled live prompt', async () => {
    const manager = new AcpRuntimeManager();
    const sessionId = `manual-runtime-${Date.now()}`;
    const reply: string[] = [];

    try {
      const handle = await manager.getOrCreateClient(
        sessionId,
        {
          provider: 'CODEX',
          workingDir: process.cwd(),
          sessionId,
        },
        {
          onSessionId: async () => Promise.resolve(),
          onRuntimeExit: async () => Promise.resolve(),
          onRuntimeError: (_message) => undefined,
          onAcpEvent: (_sessionId, event) => {
            if (
              event.type === 'acp_session_update' &&
              event.update.sessionUpdate === 'agent_message_chunk' &&
              event.update.content.type === 'text'
            ) {
              reply.push(event.update.content.text);
            }
          },
        },
        {
          workspaceId: 'manual-runtime-check',
          workingDir: process.cwd(),
        }
      );

      const categories = handle.configOptions.map((option) => option.category);
      const promptCapabilities = handle.agentCapabilities.promptCapabilities;

      expect(handle.providerSessionId).not.toMatch(/^sess_/);
      expect(handle.agentCapabilities.loadSession).toBe(true);
      expect(promptCapabilities).toEqual(expect.any(Object));
      expect(
        typeof promptCapabilities === 'object' &&
          promptCapabilities !== null &&
          'embeddedContext' in promptCapabilities
      ).toBe(true);
      expect(categories).toContain('model');
      expect(categories).toContain('mode');
      expect(categories).toContain('thought_level');
      if (RUN_REAL_PROMPT_TESTS) {
        await manager.setSessionMode(sessionId, 'read-only');
        await expect(
          manager.sendPrompt(
            sessionId,
            [
              {
                type: 'text',
                text: 'Reply with exactly ACP_SMOKE_OK. Do not use tools or modify files.',
              },
            ],
            90_000
          )
        ).resolves.toEqual({ stopReason: 'end_turn' });
        expect(reply.join('')).toContain('ACP_SMOKE_OK');
      }
    } finally {
      await manager.stopAllClients();
    }
  }, 120_000);
});
