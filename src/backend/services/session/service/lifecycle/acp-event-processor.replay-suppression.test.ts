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

function setup() {
  const domain = new SessionDomainService();
  const emitDelta = vi.spyOn(domain, 'emitDelta');
  const processor = new AcpEventProcessor({
    sessionDomainService: domain,
    runtimeManager: {
      getClient: vi.fn(),
      isSessionWorking: () => false,
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
  return { domain, emitDelta, processor, sendUpdate };
}

describe('AcpEventProcessor replay suppression', () => {
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
