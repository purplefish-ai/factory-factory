import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUBAGENTS_CHANGED_METHOD } from '@/shared/acp-protocol/subagents';
import type { AdapterSession } from './adapter-state';
import { CodexSubagentController } from './codex-subagent-controller';
import { CodexStreamEventHandler } from './stream-event-handler';

function createHarness() {
  const session: AdapterSession = {
    sessionId: 'sess_child',
    threadId: 'child',
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
  const extNotification = vi.fn(async () => undefined);
  const controller = new CodexSubagentController({
    codex: { request: vi.fn() },
    requireSession: () => session,
    createProjectionSession: () => session,
    projectThreadTurns: vi.fn(async () => []),
    extNotification,
  });
  controller.rememberSubagents('sess_parent', [session.threadId]);
  const sessions = new Map([[session.sessionId, session]]);
  const sessionIdByThreadId = new Map([[session.threadId, session.sessionId]]);
  const emitSessionUpdate = vi.fn(async () => undefined);
  const reportShapeDrift = vi.fn();
  const handler = new CodexStreamEventHandler({
    codex: { request: vi.fn() },
    sessionIdByThreadId,
    sessions,
    requireSession: () => session,
    emitSessionUpdate,
    reportShapeDrift,
    buildToolCallState: vi.fn(() => null),
    emitReasoningThoughtChunkFromItem: vi.fn(async () => undefined),
    shouldHoldTurnForPlanApproval: vi.fn(() => false),
    holdTurnUntilPlanApprovalResolves: vi.fn(),
    maybeRequestPlanApproval: vi.fn(async () => undefined),
    hasPendingPlanApprovals: vi.fn(() => false),
    settleTurn: vi.fn(),
    emitTurnFailureMessage: vi.fn(async () => undefined),
    handleSubagentTranscriptActivity: (id) => controller.handleTranscriptActivity(id),
  });
  const sendDelta = (turnId: string) =>
    handler.handleCodexNotification({
      method: 'item/agentMessage/delta',
      params: { threadId: session.threadId, turnId, itemId: 'message', delta: turnId },
    });
  return {
    session,
    sessions,
    sessionIdByThreadId,
    handler,
    sendDelta,
    extNotification,
    emitSessionUpdate,
    reportShapeDrift,
  };
}

describe('cancelled turn notifications', () => {
  afterEach(() => vi.useRealTimers());

  it('does not invalidate a cancelled subagent turn or throttle the next live event', async () => {
    vi.useFakeTimers();
    const { session, handler, sendDelta, extNotification, emitSessionUpdate } = createHarness();
    handler.markTurnCancelled(session, 'cancelled');

    await sendDelta('cancelled');
    expect(extNotification).not.toHaveBeenCalled();
    expect(emitSessionUpdate).not.toHaveBeenCalled();

    await sendDelta('live');
    expect(extNotification).toHaveBeenCalledExactlyOnceWith(SUBAGENTS_CHANGED_METHOD, {
      sessionId: 'sess_parent',
      subagentId: session.threadId,
      change: 'updated',
    });
    expect(emitSessionUpdate).toHaveBeenCalledExactlyOnceWith(session.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'live' },
    });
  });

  it.each([true, false])(
    'invalidates live subagent activity without a loaded session (mapped: %s)',
    async (mapped) => {
      const harness = createHarness();
      harness.sessions.clear();
      if (!mapped) {
        harness.sessionIdByThreadId.clear();
      }

      await harness.sendDelta('live');

      expect(harness.extNotification).toHaveBeenCalledExactlyOnceWith(SUBAGENTS_CHANGED_METHOD, {
        sessionId: 'sess_parent',
        subagentId: harness.session.threadId,
        change: 'updated',
      });
      expect(harness.emitSessionUpdate).not.toHaveBeenCalled();
    }
  );

  it('reports eviction when bounded cancellation history fills up', async () => {
    const { session, handler, sendDelta, emitSessionUpdate, reportShapeDrift } = createHarness();
    for (let index = 0; index < 128; index++) {
      handler.markTurnCancelled(session, `cancelled-${index}`);
    }
    expect(reportShapeDrift).not.toHaveBeenCalled();

    handler.markTurnCancelled(session, 'cancelled-128');

    expect(reportShapeDrift).toHaveBeenCalledExactlyOnceWith('cancelled_turn_history_evicted', {
      sessionId: session.sessionId,
      threadId: session.threadId,
      turnId: 'cancelled-0',
      limit: 128,
    });
    await sendDelta('cancelled-1');
    await sendDelta('cancelled-128');
    expect(emitSessionUpdate).not.toHaveBeenCalled();
    await sendDelta('live');
    expect(emitSessionUpdate).toHaveBeenCalledOnce();
  });
});
