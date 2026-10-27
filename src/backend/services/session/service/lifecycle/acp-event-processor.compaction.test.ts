import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionEventBus } from '@/backend/services/session/service/session-event-bus';
import { AcpEventProcessor, type AcpEventProcessorDependencies } from './acp-event-processor';

vi.mock('@/backend/services/session/service/logging/acp-trace-logger.service', () => ({
  acpTraceLogger: { log: vi.fn() },
}));
vi.mock('@/backend/services/session/service/logging/session-file-logger.service', () => ({
  sessionFileLogger: { log: vi.fn() },
}));

function createProcessor() {
  const domain = new SessionDomainService();
  const deps: AcpEventProcessorDependencies = {
    sessionDomainService: domain,
    runtimeManager: {
      getClient: vi.fn(),
      isSessionWorking: vi.fn().mockReturnValue(true),
    } as unknown as AcpEventProcessorDependencies['runtimeManager'],
    sessionPermissionService: {
      createPermissionBridge: vi.fn(),
      handlePermissionRequest: vi.fn(),
    } as unknown as AcpEventProcessorDependencies['sessionPermissionService'],
    sessionConfigService: {
      applyConfigOptionsUpdateDelta: vi.fn(),
    } as unknown as AcpEventProcessorDependencies['sessionConfigService'],
    onToolCallTimeout: vi.fn(),
  };
  const processor = new AcpEventProcessor(deps);
  const handler = processor.createRuntimeEventHandler('compact-session');
  const update = (value: SessionUpdate) =>
    handler.onAcpEvent?.('compact-session', { type: 'acp_session_update', update: value });
  return { domain, processor, update };
}

afterEach(() => vi.useRealTimers());

describe('ACP compaction transcript persistence', () => {
  it('flushes pending text, persists one boundary and replays it to a later viewer', () => {
    vi.useFakeTimers();
    const { domain, update } = createProcessor();
    const append = vi.spyOn(domain, 'appendClaudeEvent');
    const emit = vi.spyOn(domain, 'emitDelta');
    vi.spyOn(sessionEventBus, 'publishToSession').mockImplementation(() => undefined);
    update({
      sessionUpdate: 'compaction_update',
      compactionId: 'compact-1',
      status: 'in_progress',
    });
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Before compaction' },
    });
    update({ sessionUpdate: 'compaction_update', compactionId: 'compact-1', status: 'completed' });
    update({ sessionUpdate: 'compaction_update', compactionId: 'compact-1', status: 'completed' });

    const boundary = { type: 'system', subtype: 'compact_boundary' };
    expect(append).toHaveBeenCalledExactlyOnceWith('compact-session', boundary);
    const snapshot = domain.getTranscriptSnapshot('compact-session');
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]?.message).toMatchObject({ type: 'assistant' });
    expect(snapshot[1]?.message).toEqual(boundary);
    expect(snapshot[1]?.order).toBeGreaterThan(snapshot[0]?.order ?? -1);
    const emitted = emit.mock.calls.map(([, delta]) => delta);
    const textIndex = emitted.findIndex((delta) => delta.type === 'assistant_text_delta');
    const boundaryIndex = emitted.findIndex(
      (delta) => delta.type === 'agent_message' && delta.data.type === 'system'
    );
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(boundaryIndex).toBeGreaterThan(textIndex);
    expect(emitted.filter((delta) => delta.type === 'compact_boundary')).toHaveLength(0);
    expect(
      emitted.filter((delta) => delta.type === 'agent_message' && delta.data.type === 'system')
    ).toHaveLength(1);
    vi.advanceTimersByTime(25);
    expect(domain.getTranscriptSnapshot('compact-session')).toEqual(snapshot);

    const replay = domain.prepareLoad('compact-session', {
      phase: 'idle',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: new Date().toISOString(),
    });
    expect(replay?.replayEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent_message',
          data: boundary,
          order: snapshot[1]?.order,
        }),
      ])
    );
    expect(
      replay?.replayEvents?.filter(
        (event) => event.type === 'agent_message' && event.data.type === 'system'
      )
    ).toHaveLength(1);
  });

  it.each(['failed', 'cancelled'])(
    'retains %s feedback without persisting a success marker',
    (status) => {
      const { domain, processor, update } = createProcessor();
      const emit = vi.spyOn(domain, 'emitDelta');
      update({
        sessionUpdate: 'compaction_update',
        compactionId: 'compact-1',
        status: 'in_progress',
      });
      update({ sessionUpdate: 'compaction_update', compactionId: 'compact-1', status });
      processor.finishPromptTurn('compact-session');
      const snapshot = domain.getTranscriptSnapshot('compact-session');
      expect(snapshot).toHaveLength(1);
      expect(JSON.stringify(snapshot)).toContain(`Context compaction ${status}.`);
      expect(snapshot.some((entry) => entry.message?.subtype === 'compact_boundary')).toBe(false);
      expect(emit).toHaveBeenCalledWith('compact-session', { type: 'compacting_end' });
    }
  );
});
