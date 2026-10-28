import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable';
import { expect, it, vi } from 'vitest';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { AcpEventProcessor, type AcpEventProcessorDependencies } from './acp-event-processor';

vi.mock('@/backend/services/session/service/logging/acp-trace-logger.service', () => ({
  acpTraceLogger: { log: vi.fn() },
}));
vi.mock('@/backend/services/session/service/logging/session-file-logger.service', () => ({
  sessionFileLogger: { log: vi.fn() },
}));

it('persists a structured resume warning while keeping idle transcript replay suppressed', () => {
  const domain = new SessionDomainService();
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
  const handler = processor.createRuntimeEventHandler('notice-session');
  const update = (value: SessionUpdate) =>
    handler.onAcpEvent?.('notice-session', {
      type: 'acp_session_update',
      update: value,
    });
  processor.setReplaySuppression('notice-session', true);
  const history: SessionUpdate = {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Historical text' },
  };
  update(history);
  update({
    sessionUpdate: 'session_info_update',
    _meta: {
      jetbrains: {
        air: {
          sessionFailure: {
            id: 'resume-warning',
            revision: 1,
            severity: 'warning',
            title: 'Setting ignored',
          },
        },
      },
    },
  });
  update(history);
  processor.finishPromptTurn('notice-session');

  const messages = domain.getTranscriptSnapshot('notice-session');
  expect(messages).toHaveLength(1);
  expect(messages[0]?.message).toMatchObject({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'Warning: Setting ignored\n\n' }],
    },
  });
});
