import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { SUBAGENT_TOOL_META_KEY } from '@/shared/acp-protocol';
import type { AdapterSession, ToolCallState } from './adapter-state';
import { CodexStreamEventHandler } from './stream-event-handler';

function createSession(): AdapterSession {
  return {
    sessionId: 'sess_thread_1',
    threadId: 'thread_1',
    cwd: '/tmp/workspace',
    defaults: {
      model: 'gpt-5',
      approvalPolicy: 'on-failure',
      sandboxPolicy: { type: 'workspaceWrite' },
      reasoningEffort: 'medium',
      collaborationMode: 'default',
    },
    activeTurn: null,
    toolCallsByItemId: new Map(),
    syntheticallyCompletedToolItemIds: new Set(),
    reasoningDeltaItemIds: new Set(),
    planTextByItemId: new Map(),
    planApprovalRequestedByTurnId: new Set(),
    pendingPlanApprovalsByTurnId: new Map(),
    pendingTurnCompletionsByTurnId: new Map(),
    commandApprovalScopes: new Set(),
    replayedTurnItemKeys: new Set(),
  };
}

describe('stream-event-handler', () => {
  it('reports active task goal transitions for the parent thread', async () => {
    const session = createSession();
    const extNotification = vi.fn(async () => undefined);
    const handler = new CodexStreamEventHandler({
      codex: { request: vi.fn() },
      sessionIdByThreadId: new Map([['thread_1', session.sessionId]]),
      sessions: new Map([[session.sessionId, session]]),
      requireSession: vi.fn(),
      emitSessionUpdate: vi.fn(async () => undefined),
      reportShapeDrift: vi.fn(),
      buildToolCallState: vi.fn(() => null),
      emitReasoningThoughtChunkFromItem: vi.fn(async () => undefined),
      shouldHoldTurnForPlanApproval: vi.fn(() => false),
      holdTurnUntilPlanApprovalResolves: vi.fn(),
      maybeRequestPlanApproval: vi.fn(async () => undefined),
      hasPendingPlanApprovals: vi.fn(() => false),
      settleTurn: vi.fn(),
      emitTurnFailureMessage: vi.fn(async () => undefined),
      extNotification,
    });

    await handler.handleCodexNotification({
      method: 'thread/goal/updated',
      params: {
        threadId: 'thread_1',
        turnId: null,
        goal: {
          threadId: 'thread_1',
          objective: 'Finish the migration',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 100,
          timeUsedSeconds: 5,
          createdAt: 1,
          updatedAt: 2,
        },
      },
    });
    await handler.handleCodexNotification({
      method: 'thread/goal/cleared',
      params: { threadId: 'thread_1' },
    });

    expect(extNotification).toHaveBeenNthCalledWith(1, 'factoryfactory.ai/task/status-changed', {
      sessionId: session.sessionId,
      active: true,
    });
    expect(extNotification).toHaveBeenNthCalledWith(2, 'factoryfactory.ai/task/status-changed', {
      sessionId: session.sessionId,
      active: false,
    });
  });

  it('seeds task activity from the current goal when resuming a session', async () => {
    const session = createSession();
    const extNotification = vi.fn(async () => undefined);
    const request = vi.fn();
    request.mockResolvedValue({
      goal: {
        threadId: session.threadId,
        objective: 'Finish the migration',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 100,
        timeUsedSeconds: 5,
        createdAt: 1,
        updatedAt: 2,
      },
    });
    const handler = new CodexStreamEventHandler({
      codex: { request },
      sessionIdByThreadId: new Map(),
      sessions: new Map(),
      requireSession: vi.fn(),
      emitSessionUpdate: vi.fn(async () => undefined),
      reportShapeDrift: vi.fn(),
      buildToolCallState: vi.fn(() => null),
      emitReasoningThoughtChunkFromItem: vi.fn(async () => undefined),
      shouldHoldTurnForPlanApproval: vi.fn(() => false),
      holdTurnUntilPlanApprovalResolves: vi.fn(),
      maybeRequestPlanApproval: vi.fn(async () => undefined),
      hasPendingPlanApprovals: vi.fn(() => false),
      settleTurn: vi.fn(),
      emitTurnFailureMessage: vi.fn(async () => undefined),
      extNotification,
    });

    await handler.refreshTaskStatus(session);

    expect(request).toHaveBeenCalledWith('thread/goal/get', { threadId: session.threadId });
    expect(extNotification).toHaveBeenCalledWith('factoryfactory.ai/task/status-changed', {
      sessionId: session.sessionId,
      active: true,
    });
  });

  it('ignores a goal snapshot superseded by a live goal notification', async () => {
    const session = createSession();
    let resolveGoal: ((value: unknown) => void) | undefined;
    const request = vi.fn();
    request.mockReturnValue(
      new Promise<unknown>((resolve) => {
        resolveGoal = resolve;
      })
    );
    const extNotification = vi.fn(async () => undefined);
    const handler = new CodexStreamEventHandler({
      codex: { request },
      sessionIdByThreadId: new Map([[session.threadId, session.sessionId]]),
      sessions: new Map([[session.sessionId, session]]),
      requireSession: vi.fn(),
      emitSessionUpdate: vi.fn(async () => undefined),
      reportShapeDrift: vi.fn(),
      buildToolCallState: vi.fn(() => null),
      emitReasoningThoughtChunkFromItem: vi.fn(async () => undefined),
      shouldHoldTurnForPlanApproval: vi.fn(() => false),
      holdTurnUntilPlanApprovalResolves: vi.fn(),
      maybeRequestPlanApproval: vi.fn(async () => undefined),
      hasPendingPlanApprovals: vi.fn(() => false),
      settleTurn: vi.fn(),
      emitTurnFailureMessage: vi.fn(async () => undefined),
      extNotification,
    });

    const refresh = handler.refreshTaskStatus(session);
    await Promise.resolve();
    await handler.handleCodexNotification({
      method: 'thread/goal/cleared',
      params: { threadId: session.threadId },
    });
    resolveGoal?.({
      goal: {
        threadId: session.threadId,
        objective: 'Stale objective',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 100,
        timeUsedSeconds: 5,
        createdAt: 1,
        updatedAt: 2,
      },
    });
    await refresh;

    expect(extNotification).toHaveBeenCalledOnce();
    expect(extNotification).toHaveBeenCalledWith('factoryfactory.ai/task/status-changed', {
      sessionId: session.sessionId,
      active: false,
    });
  });

  it('does not fail goal refresh when task status delivery is unavailable', async () => {
    const session = createSession();
    const reportShapeDrift = vi.fn();
    const request = vi.fn();
    request.mockResolvedValue({ goal: null });
    const handler = new CodexStreamEventHandler({
      codex: { request },
      sessionIdByThreadId: new Map(),
      sessions: new Map(),
      requireSession: vi.fn(),
      emitSessionUpdate: vi.fn(async () => undefined),
      reportShapeDrift,
      buildToolCallState: vi.fn(() => null),
      emitReasoningThoughtChunkFromItem: vi.fn(async () => undefined),
      shouldHoldTurnForPlanApproval: vi.fn(() => false),
      holdTurnUntilPlanApprovalResolves: vi.fn(),
      maybeRequestPlanApproval: vi.fn(async () => undefined),
      hasPendingPlanApprovals: vi.fn(() => false),
      settleTurn: vi.fn(),
      emitTurnFailureMessage: vi.fn(async () => undefined),
      extNotification: vi.fn(() => Promise.reject(new Error('connection closed'))),
    });

    await expect(handler.refreshTaskStatus(session)).resolves.toBeUndefined();
    expect(reportShapeDrift).toHaveBeenCalledWith('task_status_notification_failed', {
      sessionId: session.sessionId,
      error: 'connection closed',
    });
  });

  it('does not fail session recovery when the optional goal request is unavailable', async () => {
    const session = createSession();
    const request = vi.fn();
    request.mockRejectedValue(new Error('thread/goal/get unavailable'));
    const reportShapeDrift = vi.fn();
    const handler = new CodexStreamEventHandler({
      codex: { request },
      sessionIdByThreadId: new Map(),
      sessions: new Map(),
      requireSession: vi.fn(),
      emitSessionUpdate: vi.fn(async () => undefined),
      reportShapeDrift,
      buildToolCallState: vi.fn(() => null),
      emitReasoningThoughtChunkFromItem: vi.fn(async () => undefined),
      shouldHoldTurnForPlanApproval: vi.fn(() => false),
      holdTurnUntilPlanApprovalResolves: vi.fn(),
      maybeRequestPlanApproval: vi.fn(async () => undefined),
      hasPendingPlanApprovals: vi.fn(() => false),
      settleTurn: vi.fn(),
      emitTurnFailureMessage: vi.fn(async () => undefined),
    });

    await expect(handler.refreshTaskStatus(session)).resolves.toBeUndefined();
    expect(reportShapeDrift).toHaveBeenCalledWith('thread_goal_get_failed', {
      threadId: session.threadId,
      error: 'thread/goal/get unavailable',
    });
  });

  it('invalidates a sub-agent transcript when its goal changes', async () => {
    const handleSubagentTranscriptActivity = vi.fn(async () => undefined);
    const handler = new CodexStreamEventHandler({
      codex: { request: vi.fn() },
      sessionIdByThreadId: new Map(),
      sessions: new Map(),
      requireSession: vi.fn(),
      emitSessionUpdate: vi.fn(async () => undefined),
      reportShapeDrift: vi.fn(),
      buildToolCallState: vi.fn(() => null),
      emitReasoningThoughtChunkFromItem: vi.fn(async () => undefined),
      shouldHoldTurnForPlanApproval: vi.fn(() => false),
      holdTurnUntilPlanApprovalResolves: vi.fn(),
      maybeRequestPlanApproval: vi.fn(async () => undefined),
      hasPendingPlanApprovals: vi.fn(() => false),
      settleTurn: vi.fn(),
      emitTurnFailureMessage: vi.fn(async () => undefined),
      handleSubagentTranscriptActivity,
    });

    await handler.handleCodexNotification({
      method: 'thread/goal/updated',
      params: {
        threadId: 'subagent-thread-1',
        turnId: null,
        goal: {
          threadId: 'subagent-thread-1',
          objective: 'Inspect the runtime',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 10,
          timeUsedSeconds: 1,
          createdAt: 1,
          updatedAt: 2,
        },
      },
    });

    expect(handleSubagentTranscriptActivity).toHaveBeenCalledWith('subagent-thread-1');
  });

  it('does not retain goal versions for sub-agent threads without an active refresh', async () => {
    const handler = new CodexStreamEventHandler({
      codex: { request: vi.fn() },
      sessionIdByThreadId: new Map(),
      sessions: new Map(),
      requireSession: vi.fn(),
      emitSessionUpdate: vi.fn(async () => undefined),
      reportShapeDrift: vi.fn(),
      buildToolCallState: vi.fn(() => null),
      emitReasoningThoughtChunkFromItem: vi.fn(async () => undefined),
      shouldHoldTurnForPlanApproval: vi.fn(() => false),
      holdTurnUntilPlanApprovalResolves: vi.fn(),
      maybeRequestPlanApproval: vi.fn(async () => undefined),
      hasPendingPlanApprovals: vi.fn(() => false),
      settleTurn: vi.fn(),
      emitTurnFailureMessage: vi.fn(async () => undefined),
      handleSubagentTranscriptActivity: vi.fn(async () => undefined),
    });

    await handler.handleCodexNotification({
      method: 'thread/goal/cleared',
      params: { threadId: 'completed-subagent-thread' },
    });

    const internalHandler = handler as unknown as {
      goalRefreshStateByThreadId: Map<string, unknown>;
    };
    expect(internalHandler.goalRefreshStateByThreadId.size).toBe(0);
  });

  it('projects replay turns into updates without emitting them', async () => {
    const session = createSession();
    const emitSessionUpdate = vi.fn(async () => undefined);
    const recordSubagentActivity = vi.fn(async () => undefined);
    const handler = new CodexStreamEventHandler({
      codex: { request: vi.fn() },
      sessionIdByThreadId: new Map(),
      sessions: new Map(),
      requireSession: vi.fn(),
      emitSessionUpdate,
      reportShapeDrift: vi.fn(),
      buildToolCallState: vi.fn((_session, item) =>
        item.type === 'subAgentActivity'
          ? ({
              toolCallId: item.id,
              kind: 'other',
              title: 'Start subagent nested',
              locations: [],
              affectedSubagentIds: ['nested-child'],
            } satisfies ToolCallState)
          : null
      ),
      emitReasoningThoughtChunkFromItem: vi.fn(async () => undefined),
      shouldHoldTurnForPlanApproval: vi.fn(() => false),
      holdTurnUntilPlanApprovalResolves: vi.fn(),
      maybeRequestPlanApproval: vi.fn(async () => undefined),
      hasPendingPlanApprovals: vi.fn(() => false),
      settleTurn: vi.fn(),
      emitTurnFailureMessage: vi.fn(async () => undefined),
      recordSubagentActivity,
    });

    const updates = await handler.projectThreadTurns(session, [
      {
        id: 'turn-1',
        status: 'completed',
        items: [
          {
            type: 'userMessage',
            id: 'user-1',
            content: [{ type: 'text', text: 'Question' }],
          },
          { type: 'agentMessage', id: 'agent-1', text: 'Answer' },
          {
            type: 'subAgentActivity',
            id: 'subagent-1',
            agentThreadId: 'nested-child',
            agentPath: 'review/nested',
            kind: 'started',
          },
        ],
      },
    ]);

    expect(updates).toEqual([
      {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Question' },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Answer' },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'subagent-1',
        title: 'Start subagent nested',
        kind: 'other',
        status: 'completed',
        rawInput: {
          type: 'subAgentActivity',
          id: 'subagent-1',
          agentThreadId: 'nested-child',
          agentPath: 'review/nested',
          kind: 'started',
        },
        rawOutput: {
          type: 'subAgentActivity',
          id: 'subagent-1',
          agentThreadId: 'nested-child',
          agentPath: 'review/nested',
          kind: 'started',
        },
      },
    ]);
    expect(emitSessionUpdate).not.toHaveBeenCalled();
    expect(recordSubagentActivity).not.toHaveBeenCalled();
  });

  it('projects recovery turns with an unknown status and reports shape drift', async () => {
    const session = createSession();
    const reportShapeDrift = vi.fn();
    const handler = new CodexStreamEventHandler({
      codex: { request: vi.fn() },
      sessionIdByThreadId: new Map(),
      sessions: new Map(),
      requireSession: vi.fn(),
      emitSessionUpdate: vi.fn(async () => undefined),
      reportShapeDrift,
      buildToolCallState: vi.fn(() => null),
      emitReasoningThoughtChunkFromItem: vi.fn(async () => undefined),
      shouldHoldTurnForPlanApproval: vi.fn(() => false),
      holdTurnUntilPlanApprovalResolves: vi.fn(),
      maybeRequestPlanApproval: vi.fn(async () => undefined),
      hasPendingPlanApprovals: vi.fn(() => false),
      settleTurn: vi.fn(),
      emitTurnFailureMessage: vi.fn(async () => undefined),
    });

    await expect(
      handler.projectThreadTurns(session, [
        {
          id: 'future-turn',
          status: 'pausedByProvider',
          items: [{ type: 'agentMessage', id: 'answer', text: 'Still readable' }],
        },
      ])
    ).resolves.toEqual([
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Still readable' },
      },
    ]);
    expect(reportShapeDrift).toHaveBeenCalledWith('unknown_turn_status', {
      source: 'thread/history',
      status: 'pausedByProvider',
    });
  });

  it('reports shape drift for malformed notifications', async () => {
    const reportShapeDrift = vi.fn();
    const handler = new CodexStreamEventHandler({
      codex: { request: vi.fn() },
      sessionIdByThreadId: new Map(),
      sessions: new Map(),
      requireSession: vi.fn(),
      emitSessionUpdate: vi.fn(async () => undefined),
      reportShapeDrift,
      buildToolCallState: vi.fn(),
      emitReasoningThoughtChunkFromItem: vi.fn(async () => undefined),
      shouldHoldTurnForPlanApproval: vi.fn(() => false),
      holdTurnUntilPlanApprovalResolves: vi.fn(),
      maybeRequestPlanApproval: vi.fn(async () => undefined),
      hasPendingPlanApprovals: vi.fn(() => false),
      settleTurn: vi.fn(),
      emitTurnFailureMessage: vi.fn(async () => undefined),
    });

    await handler.handleCodexNotification({ method: 'invalid/notification', params: {} });

    expect(reportShapeDrift).toHaveBeenCalledWith(
      'malformed_notification',
      expect.objectContaining({ method: 'invalid/notification' })
    );
  });

  it('settles an unknown completed-turn status and reports shape drift', async () => {
    const session = createSession();
    session.activeTurn = {
      turnId: 'turn_1',
      cancelRequested: false,
      settled: false,
      resolve: vi.fn(),
    };
    const reportShapeDrift = vi.fn();
    const settleTurn = vi.fn();
    const handler = new CodexStreamEventHandler({
      codex: { request: vi.fn() },
      sessionIdByThreadId: new Map([['thread_1', session.sessionId]]),
      sessions: new Map([[session.sessionId, session]]),
      requireSession: vi.fn(),
      emitSessionUpdate: vi.fn(async () => undefined),
      reportShapeDrift,
      buildToolCallState: vi.fn(),
      emitReasoningThoughtChunkFromItem: vi.fn(async () => undefined),
      shouldHoldTurnForPlanApproval: vi.fn(() => false),
      holdTurnUntilPlanApprovalResolves: vi.fn(),
      maybeRequestPlanApproval: vi.fn(async () => undefined),
      hasPendingPlanApprovals: vi.fn(() => false),
      settleTurn,
      emitTurnFailureMessage: vi.fn(async () => undefined),
    });

    await handler.handleCodexNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread_1',
        turn: {
          id: 'turn_1',
          status: 'supersededByProvider',
          items: [],
        },
      },
    });

    expect(reportShapeDrift).toHaveBeenCalledWith('unknown_turn_status', {
      source: 'turn/completed',
      status: 'supersededByProvider',
    });
    expect(settleTurn).toHaveBeenCalledWith(session, 'end_turn');
  });

  it('emits tool_call update for started command execution item', async () => {
    const session = createSession();
    const emitSessionUpdate = vi.fn(async () => undefined);
    const toolState: ToolCallState = {
      toolCallId: 'call_1',
      kind: 'execute',
      title: 'Read README.md',
      locations: [{ path: '/tmp/workspace/README.md' }],
    };

    const handler = new CodexStreamEventHandler({
      codex: { request: vi.fn() },
      sessionIdByThreadId: new Map([['thread_1', 'sess_thread_1']]),
      sessions: new Map([['sess_thread_1', session]]),
      requireSession: vi.fn(),
      emitSessionUpdate,
      reportShapeDrift: vi.fn(),
      buildToolCallState: vi.fn(() => toolState),
      emitReasoningThoughtChunkFromItem: vi.fn(async () => undefined),
      shouldHoldTurnForPlanApproval: vi.fn(() => false),
      holdTurnUntilPlanApprovalResolves: vi.fn(),
      maybeRequestPlanApproval: vi.fn(async () => undefined),
      hasPendingPlanApprovals: vi.fn(() => false),
      settleTurn: vi.fn(),
      emitTurnFailureMessage: vi.fn(async () => undefined),
    });

    await handler.handleCodexNotification({
      method: 'item/started',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        item: {
          type: 'commandExecution',
          id: 'item_1',
          status: 'inProgress',
          command: 'cat README.md',
        },
      },
    });

    expect(emitSessionUpdate).toHaveBeenCalledWith(
      'sess_thread_1',
      expect.objectContaining({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        title: 'Read README.md',
        status: 'pending',
      })
    );
  });

  it('completes sub-agent activity once while retaining tool metadata', async () => {
    const session = createSession();
    const updates: SessionUpdate[] = [];
    const emitSessionUpdate = vi.fn((_sessionId: string, update: SessionUpdate) => {
      updates.push(update);
      return Promise.resolve();
    });
    const reportShapeDrift = vi.fn();
    const toolState: ToolCallState = {
      toolCallId: 'call_subagent_1',
      kind: 'other',
      title: 'Start subagent security',
      locations: [],
      meta: {
        [SUBAGENT_TOOL_META_KEY]: {
          id: 'child_1',
          parentSessionId: 'sess_thread_1',
        },
      },
    };

    const handler = new CodexStreamEventHandler({
      codex: { request: vi.fn() },
      sessionIdByThreadId: new Map([['thread_1', 'sess_thread_1']]),
      sessions: new Map([['sess_thread_1', session]]),
      requireSession: vi.fn(),
      emitSessionUpdate,
      reportShapeDrift,
      buildToolCallState: vi.fn(() => toolState),
      emitReasoningThoughtChunkFromItem: vi.fn(async () => undefined),
      shouldHoldTurnForPlanApproval: vi.fn(() => false),
      holdTurnUntilPlanApprovalResolves: vi.fn(),
      maybeRequestPlanApproval: vi.fn(async () => undefined),
      hasPendingPlanApprovals: vi.fn(() => false),
      settleTurn: vi.fn(),
      emitTurnFailureMessage: vi.fn(async () => undefined),
    });

    await handler.handleCodexNotification({
      method: 'item/started',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        item: {
          type: 'subAgentActivity',
          id: 'item_subagent_1',
          status: 'inProgress',
        },
      },
    });
    await handler.handleCodexNotification({
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        itemId: 'item_subagent_1',
        delta: 'working',
      },
    });
    await handler.handleCodexNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        item: {
          type: 'subAgentActivity',
          id: 'item_subagent_1',
          status: 'completed',
        },
      },
    });

    expect(updates).toEqual([
      expect.objectContaining({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_subagent_1',
        status: 'completed',
        _meta: toolState.meta,
      }),
    ]);
    expect(reportShapeDrift).not.toHaveBeenCalled();
  });

  it('correlates and invalidates a live sub-agent activity item exactly once', async () => {
    const session = createSession();
    const recordSubagentActivity = vi.fn(async () => undefined);
    const toolState: ToolCallState = {
      toolCallId: 'call_subagent_1',
      kind: 'other',
      title: 'Start subagent security',
      locations: [],
      affectedSubagentIds: ['child_1'],
    };
    const handler = new CodexStreamEventHandler({
      codex: { request: vi.fn() },
      sessionIdByThreadId: new Map([['thread_1', 'sess_thread_1']]),
      sessions: new Map([['sess_thread_1', session]]),
      requireSession: vi.fn(),
      emitSessionUpdate: vi.fn(async () => undefined),
      reportShapeDrift: vi.fn(),
      buildToolCallState: vi.fn(() => toolState),
      emitReasoningThoughtChunkFromItem: vi.fn(async () => undefined),
      shouldHoldTurnForPlanApproval: vi.fn(() => false),
      holdTurnUntilPlanApprovalResolves: vi.fn(),
      maybeRequestPlanApproval: vi.fn(async () => undefined),
      hasPendingPlanApprovals: vi.fn(() => false),
      settleTurn: vi.fn(),
      emitTurnFailureMessage: vi.fn(async () => undefined),
      recordSubagentActivity,
    });
    const item = {
      type: 'subAgentActivity',
      id: 'item_subagent_1',
      agentThreadId: 'child_1',
      agentPath: 'review/security',
      kind: 'started',
    };

    await handler.handleCodexNotification({
      method: 'item/started',
      params: { threadId: 'thread_1', turnId: 'turn_1', item },
    });
    await handler.handleCodexNotification({
      method: 'item/completed',
      params: { threadId: 'thread_1', turnId: 'turn_1', item },
    });
    await handler.handleCodexNotification({
      method: 'item/completed',
      params: { threadId: 'thread_1', turnId: 'turn_1', item },
    });

    expect(recordSubagentActivity).toHaveBeenCalledTimes(1);
    expect(recordSubagentActivity).toHaveBeenCalledWith('sess_thread_1', ['child_1'], 'created');
  });

  it('retains tool metadata when replaying history', async () => {
    const session = createSession();
    const emitSessionUpdate = vi.fn(async () => undefined);
    const request = vi.fn();
    request.mockResolvedValue({
      thread: {
        id: 'thread_1',
        turns: [
          {
            id: 'turn_1',
            items: [
              {
                type: 'subAgentActivity',
                id: 'item_subagent_1',
                agentThreadId: 'child_1',
                agentPath: 'review/security',
                kind: 'started',
              },
            ],
          },
        ],
      },
    });
    const toolState: ToolCallState = {
      toolCallId: 'call_subagent_replayed',
      kind: 'other',
      title: 'Start subagent security',
      locations: [],
      meta: {
        [SUBAGENT_TOOL_META_KEY]: {
          id: 'child_1',
          parentSessionId: 'sess_thread_1',
        },
      },
    };
    const handler = new CodexStreamEventHandler({
      codex: { request },
      sessionIdByThreadId: new Map([['thread_1', 'sess_thread_1']]),
      sessions: new Map([['sess_thread_1', session]]),
      requireSession: vi.fn(() => session),
      emitSessionUpdate,
      reportShapeDrift: vi.fn(),
      buildToolCallState: vi.fn(() => toolState),
      emitReasoningThoughtChunkFromItem: vi.fn(async () => undefined),
      shouldHoldTurnForPlanApproval: vi.fn(() => false),
      holdTurnUntilPlanApprovalResolves: vi.fn(),
      maybeRequestPlanApproval: vi.fn(async () => undefined),
      hasPendingPlanApprovals: vi.fn(() => false),
      settleTurn: vi.fn(),
      emitTurnFailureMessage: vi.fn(async () => undefined),
    });

    await handler.replayThreadHistory('sess_thread_1', 'thread_1');

    expect(emitSessionUpdate).toHaveBeenCalledWith(
      'sess_thread_1',
      expect.objectContaining({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_subagent_replayed',
        status: 'completed',
        _meta: toolState.meta,
      })
    );
  });

  it('recovers completed tool-like items that arrive without started state', async () => {
    const session = createSession();
    const emitSessionUpdate = vi.fn(async () => undefined);
    const reportShapeDrift = vi.fn();
    const toolState: ToolCallState = {
      toolCallId: 'call_recovered',
      kind: 'execute',
      title: 'exec_command',
      locations: [],
    };

    const handler = new CodexStreamEventHandler({
      codex: { request: vi.fn() },
      sessionIdByThreadId: new Map([['thread_1', 'sess_thread_1']]),
      sessions: new Map([['sess_thread_1', session]]),
      requireSession: vi.fn(),
      emitSessionUpdate,
      reportShapeDrift,
      buildToolCallState: vi.fn(() => toolState),
      emitReasoningThoughtChunkFromItem: vi.fn(async () => undefined),
      shouldHoldTurnForPlanApproval: vi.fn(() => false),
      holdTurnUntilPlanApprovalResolves: vi.fn(),
      maybeRequestPlanApproval: vi.fn(async () => undefined),
      hasPendingPlanApprovals: vi.fn(() => false),
      settleTurn: vi.fn(),
      emitTurnFailureMessage: vi.fn(async () => undefined),
    });

    await handler.handleCodexNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        item: {
          type: 'function_call',
          id: 'item_function',
          status: 'completed',
          name: 'exec_command',
          call_id: 'call_recovered',
        },
      },
    });

    expect(emitSessionUpdate).toHaveBeenCalledWith(
      'sess_thread_1',
      expect.objectContaining({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_recovered',
        title: 'exec_command',
        status: 'completed',
      })
    );
    expect(reportShapeDrift).not.toHaveBeenCalledWith(
      'item_completed_without_started_state',
      expect.anything()
    );
  });

  it('requests plan approval for recovered completed plan items', async () => {
    const session = createSession();
    session.defaults.collaborationMode = 'plan';
    session.planTextByItemId.set('item_plan', '## Proposed Plan\n1. Fix recovery approval');

    const emitSessionUpdate = vi.fn(async () => undefined);
    const shouldHoldTurnForPlanApproval = vi.fn(() => true);
    const holdTurnUntilPlanApprovalResolves = vi.fn();
    const maybeRequestPlanApproval = vi.fn(async () => undefined);
    const toolState: ToolCallState = {
      toolCallId: 'call_plan',
      kind: 'think',
      title: 'plan',
      locations: [],
    };

    const handler = new CodexStreamEventHandler({
      codex: { request: vi.fn() },
      sessionIdByThreadId: new Map([['thread_1', 'sess_thread_1']]),
      sessions: new Map([['sess_thread_1', session]]),
      requireSession: vi.fn(),
      emitSessionUpdate,
      reportShapeDrift: vi.fn(),
      buildToolCallState: vi.fn(() => toolState),
      emitReasoningThoughtChunkFromItem: vi.fn(async () => undefined),
      shouldHoldTurnForPlanApproval,
      holdTurnUntilPlanApprovalResolves,
      maybeRequestPlanApproval,
      hasPendingPlanApprovals: vi.fn(() => false),
      settleTurn: vi.fn(),
      emitTurnFailureMessage: vi.fn(async () => undefined),
    });

    const item = {
      type: 'plan',
      id: 'item_plan',
      status: 'completed',
    };

    await handler.handleCodexNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        item,
      },
    });

    expect(shouldHoldTurnForPlanApproval).toHaveBeenCalledWith(session, item, 'turn_1');
    expect(holdTurnUntilPlanApprovalResolves).toHaveBeenCalledWith(session, 'turn_1');
    expect(emitSessionUpdate).toHaveBeenCalledWith(
      'sess_thread_1',
      expect.objectContaining({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_plan',
        title: 'plan',
        kind: 'think',
        status: 'completed',
      })
    );
    expect(maybeRequestPlanApproval).toHaveBeenCalledWith(session, item, 'turn_1', toolState);
  });
});
