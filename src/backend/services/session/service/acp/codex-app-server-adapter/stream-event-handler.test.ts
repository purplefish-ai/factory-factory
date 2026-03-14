import { describe, expect, it, vi } from 'vitest';
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
});
