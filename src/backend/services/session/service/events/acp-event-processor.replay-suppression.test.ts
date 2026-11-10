import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it, vi } from 'vitest';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { AcpEventProcessor, type AcpEventProcessorDependencies } from './acp-event-processor';

vi.mock('@/backend/services/session/service/logging/acp-trace-logger.service', () => ({
  acpTraceLogger: { log: vi.fn() },
}));
vi.mock('@/backend/services/session/service/logging/session-file-logger.service', () => ({
  sessionFileLogger: { log: vi.fn() },
}));

const SESSION_ID = 'replay-session';

function setup(working = false) {
  let promptInFlight = false;
  const domain = new SessionDomainService();
  const emitDelta = vi.spyOn(domain, 'emitDelta');
  const processor = new AcpEventProcessor({
    sessionDomainService: domain,
    runtimeManager: {
      getClient: vi.fn(),
      isSessionWorking: () => working,
      isSessionPromptInFlight: () => promptInFlight,
    } as unknown as AcpEventProcessorDependencies['runtimeManager'],
    sessionPermissionService: {
      createPermissionBridge: vi.fn(),
    } as unknown as AcpEventProcessorDependencies['sessionPermissionService'],
    sessionConfigService: {} as AcpEventProcessorDependencies['sessionConfigService'],
    onToolCallTimeout: vi.fn(),
  });
  const handler = processor.createRuntimeEventHandler(SESSION_ID);
  const sendUpdate = (update: SessionUpdate) =>
    handler.onAcpEvent?.(SESSION_ID, { type: 'acp_session_update', update });
  processor.setReplaySuppression(SESSION_ID, true);
  return {
    domain,
    emitDelta,
    processor,
    handler,
    sendUpdate,
    startPrompt: () => {
      promptInFlight = true;
    },
  };
}

describe('AcpEventProcessor replay suppression', () => {
  it('remembers replayed compaction identities without publishing historical boundaries', () => {
    const { domain, handler, processor, sendUpdate, startPrompt } = setup();
    const terminal: SessionUpdate = {
      sessionUpdate: 'compaction_update',
      compactionId: 'historical',
      status: 'completed',
    };
    expect(
      handler.consumeReplayEvent?.(SESSION_ID, {
        type: 'acp_session_update',
        update: terminal,
      })
    ).toBe(true);
    expect(domain.getTranscriptSnapshot(SESSION_ID)).toEqual([]);
    startPrompt();
    sendUpdate(terminal);
    processor.finishPromptTurn(SESSION_ID);
    expect(domain.getTranscriptSnapshot(SESSION_ID)).toEqual([]);
    sendUpdate({ ...terminal, compactionId: 'live' });
    processor.finishPromptTurn(SESSION_ID);
    expect(domain.getTranscriptSnapshot(SESSION_ID)).toMatchObject([
      { message: { type: 'system', subtype: 'compact_boundary' } },
    ]);
    domain.clearAllSessions();
  });

  it.each(['created', 'updated', 'completed'] as const)(
    'retains child %s notifications during startup replay',
    (change) => {
      const { domain, handler } = setup();
      expect(
        handler.consumeReplayEvent?.(SESSION_ID, {
          type: 'acp_subagents_changed',
          subagentId: 'child',
          change,
        })
      ).toBe(false);
      domain.clearAllSessions();
    }
  );

  it.each([
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Old prompt' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Old reply' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Old thought' } },
    { sessionUpdate: 'tool_call', toolCallId: 'old-tool', title: 'Read', status: 'pending' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'old-tool', status: 'completed' },
  ] satisfies SessionUpdate[])(
    'omits hydrated $sessionUpdate before startup buffering and retains fallback replay',
    (update) => {
      const { domain, handler, processor } = setup();
      const event = { type: 'acp_session_update' as const, update };
      expect(handler.consumeReplayEvent?.(SESSION_ID, event)).toBe(true);
      processor.setReplaySuppression(SESSION_ID, false);
      expect(handler.consumeReplayEvent?.(SESSION_ID, event)).toBe(false);
      domain.clearAllSessions();
    }
  );

  it.each([
    { sessionUpdate: 'usage_update', used: 123, size: 1000 },
    { sessionUpdate: 'plan', entries: [] },
    { sessionUpdate: 'available_commands_update', availableCommands: [] },
    { sessionUpdate: 'config_option_update', configOptions: [] },
    { sessionUpdate: 'current_mode_update', currentModeId: 'agent' },
    { sessionUpdate: 'session_info_update', title: 'Saved title' },
  ] satisfies SessionUpdate[])(
    'keeps $sessionUpdate in startup while replay is suppressed',
    (update) => {
      const { domain, handler } = setup();
      expect(handler.consumeReplayEvent?.(SESSION_ID, { type: 'acp_session_update', update })).toBe(
        false
      );
      expect(
        handler.consumeReplayEvent?.(SESSION_ID, {
          type: 'acp_task_status_changed',
          active: true,
        })
      ).toBe(false);
      domain.clearAllSessions();
    }
  );

  it('restores task snapshots sent while attaching provider history', () => {
    const { domain, sendUpdate } = setup();
    const entries = [
      { content: 'Resume work', status: 'in_progress' as const, priority: 'high' as const },
    ];
    sendUpdate({ sessionUpdate: 'plan', entries });
    const replay = () =>
      domain
        .prepareLoad(SESSION_ID, {
          phase: 'idle',
          processState: 'alive',
          activity: 'IDLE',
          updatedAt: '2026-10-30T00:00:00Z',
        })
        .replayEvents.filter((event) => event.type === 'task_notification');
    expect(replay()).toEqual([
      { type: 'task_notification', message: JSON.stringify({ type: 'acp_plan', entries }) },
    ]);
    sendUpdate({ sessionUpdate: 'plan', entries: [] });
    expect(replay()).toEqual([
      { type: 'task_notification', message: JSON.stringify({ type: 'acp_plan', entries: [] }) },
    ]);
    domain.clearAllSessions();
  });

  it('keeps replay suppressed while background activity exists without a live prompt', () => {
    const { domain, processor, sendUpdate, startPrompt } = setup(true);
    sendUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Old response' },
    });
    processor.finishPromptTurn(SESSION_ID);
    expect(domain.getTranscriptSnapshot(SESSION_ID)).toEqual([]);

    startPrompt();
    sendUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Live response' },
    });
    processor.finishPromptTurn(SESSION_ID);
    expect(domain.getTranscriptSnapshot(SESSION_ID)).toMatchObject([
      {
        message: {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Live response' }] },
        },
      },
    ]);
  });

  it('forwards the attach-time usage snapshot while idle replay stays suppressed', () => {
    const { domain, emitDelta, processor, sendUpdate } = setup();
    const usage: SessionUpdate = { sessionUpdate: 'usage_update', used: 180_000, size: 200_000 };

    sendUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Historical text' },
    });
    sendUpdate(usage);
    processor.finishPromptTurn(SESSION_ID);

    const messages = domain.getTranscriptSnapshot(SESSION_ID);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toEqual({ type: 'result', result: usage });
    expect(emitDelta).toHaveBeenCalledTimes(1);
    expect(emitDelta).toHaveBeenCalledWith(SESSION_ID, {
      type: 'agent_message',
      data: { type: 'result', result: usage },
      order: messages[0]?.order,
    });
  });

  it('keeps ordinary result deltas suppressed during replay', () => {
    const { domain, emitDelta, processor } = setup();

    processor.handleAcpDelta(SESSION_ID, {
      type: 'agent_message',
      data: { type: 'result', result: 'Turn finished' },
    });
    // Exemption comes from the ACP update type, not from a result payload's shape.
    processor.handleAcpDelta(SESSION_ID, {
      type: 'agent_message',
      data: {
        type: 'result',
        result: { sessionUpdate: 'usage_update', used: 1, size: 2 },
      },
    });

    expect(domain.getTranscriptSnapshot(SESSION_ID)).toHaveLength(0);
    expect(emitDelta).not.toHaveBeenCalled();
  });
});
