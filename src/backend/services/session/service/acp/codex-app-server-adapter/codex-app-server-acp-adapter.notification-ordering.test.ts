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
    data: [
      { name: 'Default', mode: 'default' },
      { name: 'Plan', mode: 'plan' },
    ],
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

  it('finishes an item before turn completion clears its tool call state', async () => {
    const connection = createMockConnection();
    const { client, request } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, client);
    await initializeAdapter(adapter, request);

    request.mockResolvedValueOnce({
      thread: { id: 'thread_turn_completion_order', cwd: '/tmp/workspace' },
      approvalPolicy: 'on-failure',
      reasoningEffort: 'medium',
    });
    const session = await adapter.newSession({ cwd: '/tmp/workspace', mcpServers: [] });
    request.mockResolvedValueOnce({
      turn: { id: 'turn_completion_order', status: 'inProgress' },
    });
    const prompt = adapter.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'run a command' }],
    });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({ threadId: 'thread_turn_completion_order' })
      )
    );

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
      type: 'commandExecution',
      id: 'item_turn_completion_order',
      status: 'inProgress',
      command: 'echo ordered',
    };
    const started = handleCodexNotification('item/started', {
      threadId: 'thread_turn_completion_order',
      turnId: 'turn_completion_order',
      item,
    });
    await vi.waitFor(() => expect(sessionUpdate).toHaveBeenCalledTimes(1));

    const completed = handleCodexNotification('item/completed', {
      threadId: 'thread_turn_completion_order',
      turnId: 'turn_completion_order',
      item: { ...item, status: 'completed' },
    });
    const turnCompleted = handleCodexNotification('turn/completed', {
      threadId: 'thread_turn_completion_order',
      turn: { id: 'turn_completion_order', status: 'completed', error: null, items: [] },
    });

    releaseFirstUpdate();
    await Promise.all([started, completed, turnCompleted]);
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });

    expect(sessionUpdate.mock.calls.map((call) => call[0].update.sessionUpdate)).toEqual([
      'tool_call',
      'tool_call_update',
      'tool_call_update',
    ]);
  });

  it('waits for a plan hold before processing turn completion', async () => {
    let resolvePlanApproval: (value: RequestPermissionResponse) => void = () => {
      throw new Error('expected plan approval request callback');
    };
    const connection = createMockConnection();
    (connection.requestPermission as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<RequestPermissionResponse>((resolve) => {
          resolvePlanApproval = resolve;
        })
    );
    const { client, request } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, client);
    await initializeAdapter(adapter, request);

    request.mockResolvedValueOnce({
      thread: { id: 'thread_plan_hold_order', cwd: '/tmp/workspace' },
      approvalPolicy: 'on-failure',
      reasoningEffort: 'medium',
    });
    const session = await adapter.newSession({ cwd: '/tmp/workspace', mcpServers: [] });
    await adapter.setSessionMode({ sessionId: session.sessionId, modeId: 'plan' });
    request.mockResolvedValueOnce({
      turn: { id: 'turn_plan_hold_order', status: 'inProgress' },
    });
    const prompt = adapter.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'make a plan' }],
    });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({ threadId: 'thread_plan_hold_order' })
      )
    );

    const handleCodexNotification = (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification.bind(adapter);
    await handleCodexNotification('item/started', {
      threadId: 'thread_plan_hold_order',
      turnId: 'turn_plan_hold_order',
      item: { type: 'plan', id: 'item_plan_hold_order', status: 'inProgress' },
    });
    await handleCodexNotification('item/plan/delta', {
      threadId: 'thread_plan_hold_order',
      turnId: 'turn_plan_hold_order',
      itemId: 'item_plan_hold_order',
      delta: '# Plan\n- implement it',
    });

    let releaseTranscriptActivity: () => void = () => undefined;
    const transcriptActivityBlocked = new Promise<void>((resolve) => {
      releaseTranscriptActivity = resolve;
    });
    const subagentController = (
      adapter as unknown as {
        subagentController: { handleTranscriptActivity: (threadId: string) => Promise<void> };
      }
    ).subagentController;
    const handleTranscriptActivity = vi
      .spyOn(subagentController, 'handleTranscriptActivity')
      .mockImplementationOnce(async () => await transcriptActivityBlocked)
      .mockResolvedValue(undefined);

    const itemCompleted = handleCodexNotification('item/completed', {
      threadId: 'thread_plan_hold_order',
      turnId: 'turn_plan_hold_order',
      item: { type: 'plan', id: 'item_plan_hold_order', status: 'completed' },
    });
    await vi.waitFor(() => expect(handleTranscriptActivity).toHaveBeenCalledTimes(1));

    let turnCompletionProcessed = false;
    const turnCompleted = handleCodexNotification('turn/completed', {
      threadId: 'thread_plan_hold_order',
      turn: { id: 'turn_plan_hold_order', status: 'completed', error: null, items: [] },
    });
    void turnCompleted.then(() => {
      turnCompletionProcessed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(turnCompletionProcessed).toBe(false);

    releaseTranscriptActivity();
    await turnCompleted;

    let promptSettled = false;
    void prompt.then(() => {
      promptSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(promptSettled).toBe(false);

    resolvePlanApproval({ outcome: { outcome: 'selected', optionId: 'default' } });
    await itemCompleted;
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
  });
});
