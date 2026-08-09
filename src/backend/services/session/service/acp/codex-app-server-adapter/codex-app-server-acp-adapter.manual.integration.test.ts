import type { AgentSideConnection, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import {
  SUBAGENT_TOOL_META_KEY,
  SUBAGENTS_CHANGED_METHOD,
  SUBAGENTS_LIST_METHOD,
  SUBAGENTS_READ_METHOD,
  subagentListResultSchema,
  subagentReadResultSchema,
  subagentToolMetadataSchema,
} from '@/shared/acp-protocol/subagents';
import { CodexAppServerAcpAdapter } from './codex-app-server-acp-adapter';

const RUN_REAL_CODEX_APP_SERVER_TESTS = process.env.RUN_REAL_CODEX_APP_SERVER_TESTS === '1';
const RUN_REAL_CODEX_PROMPT_TESTS = process.env.RUN_REAL_CODEX_APP_SERVER_PROMPT_TESTS === '1';

type ManualConnection = Pick<
  AgentSideConnection,
  'closed' | 'extNotification' | 'requestPermission' | 'sessionUpdate'
>;

type RecordedUpdate = {
  sessionId: string;
  update: unknown;
};

type RecordedExtNotification = {
  method: string;
  params: Record<string, unknown>;
};

function createManualConnection(): {
  close: () => void;
  connection: ManualConnection;
  extNotifications: RecordedExtNotification[];
  updates: RecordedUpdate[];
} {
  let resolveClosed: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const extNotifications: RecordedExtNotification[] = [];
  const updates: RecordedUpdate[] = [];

  return {
    close: () => resolveClosed?.(),
    connection: {
      closed,
      extNotification: async (method, params) => {
        await Promise.resolve();
        extNotifications.push({ method, params });
      },
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
    extNotifications,
    updates,
  };
}

function hasFactoryFactorySubagentMeta(recorded: RecordedUpdate): boolean {
  if (!(isRecord(recorded.update) && isRecord(recorded.update._meta))) {
    return false;
  }
  return subagentToolMetadataSchema.safeParse(recorded.update._meta[SUBAGENT_TOOL_META_KEY])
    .success;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function settleAdapterClose(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
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

  promptItIfEnabled(
    'surfaces one real sub-agent and recovers its transcript after adapter reload',
    async () => {
      const fixture = createManualConnection();
      const adapter = new CodexAppServerAcpAdapter(fixture.connection as AgentSideConnection);
      let reloadedFixture: ReturnType<typeof createManualConnection> | null = null;

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
          prompt: [
            {
              type: 'text',
              text: [
                'Spawn exactly one bounded research sub-agent.',
                'Ask it to read package.json and report only the package name.',
                'Wait for that sub-agent to finish before replying.',
                'Do not spawn any other sub-agents.',
                'Then reply with the package name.',
              ].join(' '),
            },
          ],
        });

        expect(result.stopReason).toBe('end_turn');
        expect(fixture.updates.some(hasFactoryFactorySubagentMeta)).toBe(true);
        expect(
          fixture.extNotifications.some(
            (notification) => notification.method === SUBAGENTS_CHANGED_METHOD
          )
        ).toBe(true);

        const list = subagentListResultSchema.parse(
          await adapter.extMethod(SUBAGENTS_LIST_METHOD, {
            sessionId: session.sessionId,
            cursor: null,
            limit: 50,
          })
        );
        expect(list.subagents.length).toBeGreaterThan(0);
        const childId = list.subagents[0]!.id;
        const read = subagentReadResultSchema.parse(
          await adapter.extMethod(SUBAGENTS_READ_METHOD, {
            sessionId: session.sessionId,
            subagentId: childId,
            cursor: null,
            limit: 10,
          })
        );
        expect(read.updates.length).toBeGreaterThan(0);

        fixture.close();
        await settleAdapterClose();

        reloadedFixture = createManualConnection();
        const reloadedAdapter = new CodexAppServerAcpAdapter(
          reloadedFixture.connection as AgentSideConnection
        );
        await reloadedAdapter.initialize({
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: {
            name: 'factory-factory-manual-test',
            version: '0.1.0',
          },
        });
        await reloadedAdapter.loadSession({
          sessionId: session.sessionId,
          cwd: process.cwd(),
          mcpServers: [],
        });

        const reloadedList = subagentListResultSchema.parse(
          await reloadedAdapter.extMethod(SUBAGENTS_LIST_METHOD, {
            sessionId: session.sessionId,
            cursor: null,
            limit: 50,
          })
        );
        expect(reloadedList.subagents.map((item) => item.id)).toContain(childId);
        const reloadedRead = subagentReadResultSchema.parse(
          await reloadedAdapter.extMethod(SUBAGENTS_READ_METHOD, {
            sessionId: session.sessionId,
            subagentId: childId,
            cursor: null,
            limit: 10,
          })
        );
        expect(reloadedRead.updates.length).toBeGreaterThan(0);
      } finally {
        fixture.close();
        reloadedFixture?.close();
        await settleAdapterClose();
      }
    },
    600_000
  );
});
