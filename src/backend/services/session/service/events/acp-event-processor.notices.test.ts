import { expect, it, vi } from 'vitest';
import { SessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import type { SessionUpdate } from '@/shared/acp-protocol/sdk-types';
import { AcpEventProcessor, type AcpEventProcessorDependencies } from './acp-event-processor';

vi.mock('@/backend/services/session/service/logging/acp-trace-logger.service', () => ({
  acpTraceLogger: { log: vi.fn() },
}));
vi.mock('@/backend/services/session/service/logging/session-file-logger.service', () => ({
  sessionFileLogger: { log: vi.fn() },
}));

function createNoticeSession() {
  const domain = new SessionDomainService();
  const processor = new AcpEventProcessor({
    sessionDomainService: domain,
    runtimeManager: {
      getClient: vi.fn(),
      isSessionWorking: () => false,
      isSessionPromptInFlight: () => false,
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
  processor.registerSessionContext('notice-session', {
    provider: 'CODEX',
    workingDir: '/work',
    workspaceId: 'workspace',
  });
  return { domain, processor, update };
}

it('persists a structured resume warning while keeping idle transcript replay suppressed', () => {
  const { domain, processor, update } = createNoticeSession();
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
    type: 'session_notice',
    notice: { id: 'resume-warning', revision: 1, provider: 'CODEX', title: 'Setting ignored' },
  });
});

function retry(revision: number, id = 'turn-1:error'): SessionUpdate {
  return {
    sessionUpdate: 'session_info_update',
    _meta: {
      jetbrains: {
        air: {
          sessionFailure: {
            id,
            revision,
            severity: 'warning',
            category: 'connection',
            title: `Reconnecting... ${revision}/5`,
          },
        },
      },
    },
  };
}

it('updates one reconnect entry and marks it recovered when the response resumes', () => {
  const { domain, processor, update } = createNoticeSession();
  processor.beginPromptTurn('notice-session');
  update(retry(1));
  const first = domain.getTranscriptSnapshot('notice-session')[0];
  update(retry(2));
  update(retry(1));
  expect(domain.getTranscriptSnapshot('notice-session')).toMatchObject([
    {
      id: first?.id,
      order: first?.order,
      message: { notice: { revision: 2, reconnect: 'retrying' } },
    },
  ]);
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Back online.' } });
  processor.finishPromptTurn('notice-session', 'end_turn');
  expect(domain.getTranscriptSnapshot('notice-session')).toMatchObject([
    {
      id: first?.id,
      order: first?.order,
      message: { notice: { revision: 2, reconnect: 'recovered' } },
    },
    { message: { type: 'assistant' } },
  ]);
});

it.each(['end_turn', 'cancelled', undefined])(
  'closes an outstanding retry when the prompt ends with %s',
  (reason) => {
    const { domain, processor, update } = createNoticeSession();
    processor.beginPromptTurn('notice-session');
    update(retry(1));
    processor.finishPromptTurn('notice-session', reason);
    expect(domain.getTranscriptSnapshot('notice-session')).toMatchObject([
      { message: { notice: { reconnect: reason === 'end_turn' ? 'recovered' : 'ended' } } },
    ]);
  }
);

it('records recovery on thought output before a second disconnect in the same prompt', () => {
  const { domain, processor, update } = createNoticeSession();
  processor.beginPromptTurn('notice-session');
  update(retry(1));
  update({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'Resuming work.' },
  });
  update(retry(1, 'turn-1:second-error'));
  processor.finishPromptTurn('notice-session', 'cancelled');
  const notices = domain
    .getTranscriptSnapshot('notice-session')
    .flatMap(({ message }) => (message?.type === 'session_notice' ? [message.notice] : []));
  expect(notices).toMatchObject([
    { id: 'turn-1:error', reconnect: 'recovered' },
    { id: 'turn-1:second-error', reconnect: 'ended' },
  ]);
});
