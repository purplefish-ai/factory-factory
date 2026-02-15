import { describe, expect, it } from 'vitest';
import { AcpRuntimeManager } from './acp-runtime-manager';

const RUN_REAL_CODEX_APP_SERVER_TESTS = process.env.RUN_REAL_CODEX_APP_SERVER_TESTS === '1';
const describeIfRealCodex = RUN_REAL_CODEX_APP_SERVER_TESTS ? describe : describe.skip;

describeIfRealCodex('AcpRuntimeManager (manual real codex app-server)', () => {
  it('completes initialize/newSession handshake via internal CODEX adapter', async () => {
    const manager = new AcpRuntimeManager();
    const sessionId = `manual-runtime-${Date.now()}`;

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
          onExit: async () => Promise.resolve(),
          onError: (_message) => undefined,
          onAcpEvent: (_event) => undefined,
        },
        {
          workspaceId: 'manual-runtime-check',
          workingDir: process.cwd(),
        }
      );

      const categories = handle.configOptions.map((option) => option.category);
      const promptCapabilities = handle.agentCapabilities.promptCapabilities;

      expect(handle.providerSessionId.startsWith('sess_')).toBe(true);
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
    } finally {
      await manager.stopAllClients();
    }
  }, 120_000);
});
