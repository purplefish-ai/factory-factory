import type { AgentSideConnection, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { CodexAppServerAcpAdapter } from './codex-app-server-acp-adapter';

const RUN_REAL_CODEX_APP_SERVER_TESTS = process.env.RUN_REAL_CODEX_APP_SERVER_TESTS === '1';
const RUN_REAL_CODEX_PROMPT_TESTS = process.env.RUN_REAL_CODEX_APP_SERVER_PROMPT_TESTS === '1';

type ManualConnection = Pick<AgentSideConnection, 'closed' | 'requestPermission' | 'sessionUpdate'>;

type RecordedUpdate = {
  sessionId: string;
  update: unknown;
};

function createManualConnection(): {
  close: () => void;
  connection: ManualConnection;
  updates: RecordedUpdate[];
} {
  let resolveClosed: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const updates: RecordedUpdate[] = [];

  return {
    close: () => resolveClosed?.(),
    connection: {
      closed,
      sessionUpdate: async (payload) => {
        await Promise.resolve();
        updates.push(payload as RecordedUpdate);
      },
      requestPermission: async (request) => {
        await Promise.resolve();
        const allowOption = request.options.find((option) => option.kind === 'allow_once');
        return {
          outcome: {
            outcome: 'selected',
            optionId: allowOption?.optionId ?? request.options[0]?.optionId ?? 'allow_once',
          },
        } satisfies RequestPermissionResponse;
      },
    },
    updates,
  };
}

const describeIfRealCodex = RUN_REAL_CODEX_APP_SERVER_TESTS ? describe : describe.skip;
const promptItIfEnabled = RUN_REAL_CODEX_PROMPT_TESTS ? it : it.skip;

describeIfRealCodex('CodexAppServerAcpAdapter (manual real app-server)', () => {
  it('initializes and creates a session with real codex app-server', async () => {
    const fixture = createManualConnection();
    const adapter = new CodexAppServerAcpAdapter(fixture.connection as AgentSideConnection);

    try {
      await adapter.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: {
          name: 'factory-factory-manual-test',
          version: '0.1.0',
        },
      });

      const result = await adapter.newSession({
        cwd: process.cwd(),
        mcpServers: [],
      });
      const configOptions = result.configOptions ?? [];

      expect(result.sessionId.startsWith('sess_')).toBe(true);
      expect(configOptions.some((option) => option.category === 'model')).toBe(true);
      expect(configOptions.some((option) => option.category === 'mode')).toBe(true);
      expect(configOptions.some((option) => option.category === 'thought_level')).toBe(true);
    } finally {
      fixture.close();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, 120_000);

  promptItIfEnabled(
    'runs a prompt turn end-to-end against real codex app-server',
    async () => {
      const fixture = createManualConnection();
      const adapter = new CodexAppServerAcpAdapter(fixture.connection as AgentSideConnection);

      try {
        await adapter.initialize({
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: {
            name: 'factory-factory-manual-test',
            version: '0.1.0',
          },
        });

        const session = await adapter.newSession({
          cwd: process.cwd(),
          mcpServers: [],
        });
        const result = await adapter.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Reply with exactly one word: pong' }],
        });

        expect(['end_turn', 'cancelled']).toContain(result.stopReason);
        expect(fixture.updates.length).toBeGreaterThan(0);
      } finally {
        fixture.close();
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    },
    180_000
  );
});
