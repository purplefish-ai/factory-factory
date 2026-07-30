import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SessionLifecycleEventRecord,
  SessionLifecycleEventStore,
} from '@/backend/services/session/resources/session-lifecycle-event.accessor';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { SessionLifecycleEventService } from './session-lifecycle-event.service';

const mockError = vi.fn();

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ error: (...args: unknown[]) => mockError(...args) }),
}));

const eventRecord: SessionLifecycleEventRecord = {
  id: 'event-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  kind: 'TURN_INTERRUPTED',
  reason: 'PROMPT_TIMEOUT',
  message: 'Turn stopped: reached the 4-hour limit.',
  dedupeKey: 'prompt-timeout',
  createdAt: new Date('2026-07-30T12:22:23.353Z'),
};

const input = {
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  kind: 'TURN_INTERRUPTED' as const,
  reason: 'PROMPT_TIMEOUT' as const,
  message: 'Turn stopped: reached the 4-hour limit.',
  dedupeKey: 'prompt-timeout',
  createdAt: new Date('2026-07-30T12:22:23.353Z'),
};

describe('SessionLifecycleEventService', () => {
  let domain: SessionDomainService;
  let store: {
    upsert: ReturnType<typeof vi.fn>;
    findBySessionId: ReturnType<typeof vi.fn>;
  };
  let service: SessionLifecycleEventService;

  beforeEach(() => {
    vi.clearAllMocks();
    domain = new SessionDomainService();
    store = {
      upsert: vi.fn().mockResolvedValue(eventRecord),
      findBySessionId: vi.fn(),
    };
    service = new SessionLifecycleEventService({
      store: store as SessionLifecycleEventStore,
      sessionDomainService: domain,
    });
  });

  it('persists before publishing and publishes a duplicate only once', async () => {
    const calls: string[] = [];
    store.upsert.mockImplementation(() => {
      calls.push('persist');
      return Promise.resolve(eventRecord);
    });
    vi.spyOn(domain, 'upsertLifecycleMessage').mockImplementation(() => {
      calls.push('upsert');
      return calls.filter((call) => call === 'upsert').length === 1;
    });
    vi.spyOn(domain, 'emitDelta').mockImplementation(() => calls.push('emit'));

    await service.record(input);
    await service.record(input);

    expect(calls.slice(0, 3)).toEqual(['persist', 'upsert', 'emit']);
    expect(calls.filter((call) => call === 'emit')).toHaveLength(1);
  });

  it('emits a best-effort transient lifecycle message when persistence fails', async () => {
    store.upsert.mockRejectedValue(new Error('database unavailable'));
    const emitDelta = vi.spyOn(domain, 'emitDelta').mockImplementation(() => undefined);

    await expect(service.record(input)).resolves.toBeNull();

    expect(domain.getTranscriptSnapshot('session-1')).toMatchObject([
      { id: 'session-lifecycle:transient:session-1:prompt-timeout' },
    ]);
    expect(emitDelta).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'agent_message',
        data: expect.objectContaining({ type: 'session_lifecycle' }),
      })
    );
    expect(mockError).toHaveBeenCalledWith(
      'Failed persisting session lifecycle event',
      expect.any(Error),
      expect.objectContaining({ sessionId: 'session-1' })
    );
  });

  it('rehydrates lifecycle events after the in-memory store is cleared', async () => {
    store.findBySessionId.mockResolvedValue([eventRecord]);
    domain.clearSession('session-1');

    await service.hydrate('session-1');

    expect(domain.getTranscriptSnapshot('session-1').map((message) => message.id)).toContain(
      'session-lifecycle:event-1'
    );
  });
});
