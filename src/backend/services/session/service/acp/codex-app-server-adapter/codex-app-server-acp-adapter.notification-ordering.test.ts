import type { AgentSideConnection, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerAcpAdapter } from './codex-app-server-acp-adapter';

type MockConnection = Pick<
  AgentSideConnection,
  'closed' | 'sessionUpdate' | 'requestPermission' | 'extNotification'
>;
type InjectedCodexClient = NonNullable<ConstructorParameters<typeof CodexAppServerAcpAdapter>[1]>;

function createMockConnection(): MockConnection {
  return {
    closed: new Promise<void>(() => undefined),
    sessionUpdate: vi.fn(async () => undefined),
    extNotification: vi.fn(async () => undefined),
    requestPermission: vi.fn(() =>
      Promise.resolve({
        outcome: { outcome: 'selected', optionId: 'allow_once' },
      } as RequestPermissionResponse)
    ),
  };
}

function createMockCodexClient(): {
  client: InjectedCodexClient;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn();
  const client = {
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    request,
    notify: vi.fn(),
    respondSuccess: vi.fn(),
    respondError: vi.fn(),
  } as unknown as InjectedCodexClient;
  return { client, request };
}

async function initializeAdapter(
  adapter: CodexAppServerAcpAdapter,
  request: ReturnType<typeof vi.fn>
): Promise<void> {
  request.mockResolvedValueOnce({});
  request.mockResolvedValueOnce({
    requirements: {
      allowedApprovalPolicies: ['on-failure'],
      allowedSandboxModes: ['workspace-write'],
    },
  });
  request.mockResolvedValueOnce({
    data: [{ name: 'Default', mode: 'default' }],
    nextCursor: null,
  });
  request.mockResolvedValueOnce({
    data: [
      {
        id: 'gpt-5',
        displayName: 'GPT-5',
        description: 'Default model',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [],
        inputModalities: ['text'],
        isDefault: true,
      },
    ],
    nextCursor: null,
  });
  await adapter.initialize({
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.1' },
  });
}

describe('CodexAppServerAcpAdapter notification ordering', () => {
  it('keeps a replayed session when the optional task-status refresh fails', async () => {
    const connection = createMockConnection();
    const { client, request } = createMockCodexClient();
    const shapeDriftWarn = vi.fn();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, client, {
      shapeDriftWarn,
    });
    await initializeAdapter(adapter, request);

    request.mockResolvedValueOnce({
      thread: { id: 'thread_optional_goal', cwd: '/tmp/workspace' },
      approvalPolicy: 'on-failure',
      reasoningEffort: 'medium',
    });
    request.mockResolvedValueOnce({ thread: { id: 'thread_optional_goal', turns: [] } });
    const internalAdapter = adapter as unknown as {
      streamEventHandler: { refreshTaskStatus: () => Promise<void> };
    };
    vi.spyOn(internalAdapter.streamEventHandler, 'refreshTaskStatus').mockRejectedValueOnce(
      new Error('goal refresh failed')
    );

    await expect(
      adapter.loadSession({
        sessionId: 'sess_thread_optional_goal',
        cwd: '/tmp/workspace',
        mcpServers: [],
      })
    ).resolves.toMatchObject({ configOptions: expect.any(Array) });
    expect(shapeDriftWarn).toHaveBeenCalledWith(
      'Codex app-server shape drift detected',
      expect.objectContaining({ event: 'thread_goal_refresh_failed' })
    );
  });

  it('preserves Codex notification order across asynchronous ACP updates', async () => {
    const connection = createMockConnection();
    const { client, request } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, client);
    await initializeAdapter(adapter, request);

    request.mockResolvedValueOnce({
      thread: { id: 'thread_notification_order', cwd: '/tmp/workspace' },
      approvalPolicy: 'on-failure',
      reasoningEffort: 'medium',
    });
    await adapter.newSession({ cwd: '/tmp/workspace', mcpServers: [] });

    const sessionUpdate = connection.sessionUpdate as ReturnType<typeof vi.fn>;
    sessionUpdate.mockClear();
    let releaseFirstUpdate: () => void = () => undefined;
    const firstUpdateBlocked = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    sessionUpdate
      .mockImplementationOnce(async () => await firstUpdateBlocked)
      .mockResolvedValue(undefined);

    const handleCodexNotification = (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification.bind(adapter);
    const item = {
      type: 'subAgentActivity',
      id: 'item_notification_order',
      callId: 'call_notification_order',
      agentThreadId: 'child_notification_order',
      agentPath: 'review/notification_order',
      kind: 'started',
    };
    const started = handleCodexNotification('item/started', {
      threadId: 'thread_notification_order',
      turnId: 'turn_notification_order',
      item: { ...item, status: 'inProgress' },
    });
    await vi.waitFor(() => expect(sessionUpdate).toHaveBeenCalledTimes(1));

    const completed = handleCodexNotification('item/completed', {
      threadId: 'thread_notification_order',
      turnId: 'turn_notification_order',
      item: { ...item, status: 'completed' },
    });
    releaseFirstUpdate();
    await Promise.all([started, completed]);

    expect(sessionUpdate.mock.calls.map((call) => call[0].update.status).filter(Boolean)).toEqual([
      'pending',
      'in_progress',
      'completed',
    ]);
  });
});
