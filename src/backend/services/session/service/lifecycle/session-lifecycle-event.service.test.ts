import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SessionLifecycleEventRecord,
  SessionLifecycleEventStore,
} from '@/backend/services/session/resources/session-lifecycle-event.accessor';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionEventBus } from '@/backend/services/session/service/session-event-bus';
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
    const providerMessage = {
      id: 'provider-at-noon',
      source: 'agent' as const,
      timestamp: '2026-07-30T12:00:00.000Z',
      order: 0,
      message: {
        type: 'assistant' as const,
        message: { role: 'assistant' as const, content: 'Provider message' },
      },
    };
    domain.replaceTranscript('session-1', [providerMessage]);
    const upsertLifecycleMessage = vi.spyOn(domain, 'upsertLifecycleMessage');
    const emitSessionSnapshot = vi
      .spyOn(domain, 'emitSessionSnapshot')
      .mockImplementation(() => undefined);

    await service.record(input);
    await service.record(input);

    expect(store.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      upsertLifecycleMessage.mock.invocationCallOrder[0]!
    );
    expect(upsertLifecycleMessage).toHaveBeenCalledTimes(2);
    expect(emitSessionSnapshot).toHaveBeenCalledOnce();
    expect(emitSessionSnapshot).toHaveBeenCalledWith('session-1');
    expect(domain.getTranscriptSnapshot('session-1').map((message) => message.id)).toEqual([
      'provider-at-noon',
      'session-lifecycle:event-1',
    ]);
    expect(domain.getTranscriptSnapshot('session-1').map((message) => message.order)).toEqual([
      0, 1,
    ]);
  });

  it('re-emits a provider message whose order shifts after an earlier lifecycle event', async () => {
    const providerMessage = {
      id: 'provider-at-noon',
      source: 'agent' as const,
      timestamp: '2026-07-30T12:00:00.000Z',
      order: 0,
      message: {
        type: 'assistant' as const,
        message: { role: 'assistant' as const, content: 'Provider message' },
      },
    };
    const earlierEvent = {
      ...eventRecord,
      id: 'event-at-eleven',
      createdAt: new Date('2026-07-30T11:00:00.000Z'),
    };
    store.upsert.mockResolvedValue(earlierEvent);
    domain.replaceTranscript('session-1', [providerMessage]);
    const emitSessionSnapshot = vi
      .spyOn(domain, 'emitSessionSnapshot')
      .mockImplementation(() => undefined);

    await service.record({ ...input, createdAt: earlierEvent.createdAt });

    expect(emitSessionSnapshot).toHaveBeenCalledOnce();
    expect(
      domain.getTranscriptSnapshot('session-1').map(({ id, order }) => ({ id, order }))
    ).toEqual([
      { id: 'session-lifecycle:event-at-eleven', order: 0 },
      { id: 'provider-at-noon', order: 1 },
    ]);
  });

  it('publishes one authoritative snapshot when lifecycle insertion reindexes mixed transcript rows', async () => {
    domain.replaceTranscript('session-1', [
      {
        id: 'provider-user',
        source: 'user',
        text: 'Question',
        timestamp: '2026-07-30T11:00:00.000Z',
        order: 0,
      },
      {
        id: 'provider-agent',
        source: 'agent',
        timestamp: '2026-07-30T13:00:00.000Z',
        order: 1,
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: 'Answer' },
        },
      },
    ]);
    const publishToSession = vi
      .spyOn(sessionEventBus, 'publishToSession')
      .mockImplementation(() => undefined);

    await service.record(input);

    const snapshots = publishToSession.mock.calls
      .map(([, payload]) => payload)
      .filter((payload) => payload.type === 'session_snapshot');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.messages?.map((message) => message.id)).toEqual([
      'provider-user',
      'session-lifecycle:event-1',
      'provider-agent',
    ]);
    expect(snapshots[0]?.messages?.map((message) => message.order)).toEqual([0, 1, 2]);
  });

  it('returns the durable event when live publication fails', async () => {
    const upsertLifecycleMessage = vi.spyOn(domain, 'upsertLifecycleMessage');
    vi.spyOn(domain, 'emitSessionSnapshot').mockImplementation(() => {
      throw new Error('emit failed');
    });

    await expect(service.record(input)).resolves.toEqual(eventRecord);

    expect(store.upsert).toHaveBeenCalledTimes(1);
    expect(upsertLifecycleMessage).toHaveBeenCalledTimes(1);
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockError).toHaveBeenCalledWith(
      'Failed publishing session lifecycle event',
      expect.any(Error),
      expect.objectContaining({ sessionId: 'session-1', durable: true })
    );
  });

  it('emits a best-effort transient lifecycle message when persistence fails', async () => {
    store.upsert.mockRejectedValue(new Error('database unavailable'));
    const emitSessionSnapshot = vi
      .spyOn(domain, 'emitSessionSnapshot')
      .mockImplementation(() => undefined);

    await expect(service.record(input)).resolves.toBeNull();

    expect(domain.getTranscriptSnapshot('session-1')).toMatchObject([
      { id: 'session-lifecycle:transient:session-1:prompt-timeout' },
    ]);
    expect(emitSessionSnapshot).toHaveBeenCalledWith('session-1');
    expect(mockError).toHaveBeenCalledWith(
      'Failed persisting session lifecycle event',
      expect.any(Error),
      expect.objectContaining({ sessionId: 'session-1' })
    );
  });

  it('returns null when persistence and transient publication both fail', async () => {
    store.upsert.mockRejectedValue(new Error('database unavailable'));
    const upsertLifecycleMessage = vi.spyOn(domain, 'upsertLifecycleMessage');
    vi.spyOn(domain, 'emitSessionSnapshot').mockImplementation(() => {
      throw new Error('emit failed');
    });

    await expect(service.record(input)).resolves.toBeNull();

    expect(store.upsert).toHaveBeenCalledTimes(1);
    expect(upsertLifecycleMessage).toHaveBeenCalledTimes(1);
    expect(mockError).toHaveBeenCalledTimes(2);
    expect(mockError.mock.calls[0]).toEqual([
      'Failed persisting session lifecycle event',
      expect.any(Error),
      expect.objectContaining({ sessionId: 'session-1' }),
    ]);
    expect(mockError.mock.calls[1]).toEqual([
      'Failed publishing session lifecycle event',
      expect.any(Error),
      expect.objectContaining({ sessionId: 'session-1', durable: false }),
    ]);
  });

  it('replaces a transient lifecycle message after persistence recovers', async () => {
    store.upsert
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(eventRecord);
    const emitSessionSnapshot = vi
      .spyOn(domain, 'emitSessionSnapshot')
      .mockImplementation(() => undefined);

    await service.record(input);
    await service.record(input);

    expect(domain.getTranscriptSnapshot('session-1').map((message) => message.id)).toEqual([
      'session-lifecycle:event-1',
    ]);
    expect(emitSessionSnapshot).toHaveBeenCalledTimes(2);
  });

  it('authoritatively removes the transient row when durable persistence recovers', async () => {
    store.upsert
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(eventRecord);
    const publishToSession = vi
      .spyOn(sessionEventBus, 'publishToSession')
      .mockImplementation(() => undefined);

    await service.record(input);
    await service.record(input);

    const snapshots = publishToSession.mock.calls
      .map(([, payload]) => payload)
      .filter((payload) => payload.type === 'session_snapshot');
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.messages?.map((message) => message.id)).toEqual([
      'session-lifecycle:transient:session-1:prompt-timeout',
    ]);
    expect(snapshots[1]?.messages?.map((message) => message.id)).toEqual([
      'session-lifecycle:event-1',
    ]);
  });

  it('rehydrates lifecycle events after the in-memory store is cleared', async () => {
    store.findBySessionId.mockResolvedValue([eventRecord]);
    domain.clearSession('session-1');

    await service.hydrate('session-1');

    expect(domain.getTranscriptSnapshot('session-1').map((message) => message.id)).toContain(
      'session-lifecycle:event-1'
    );
  });

  it('does not rewrite provider history when there are no lifecycle events to hydrate', async () => {
    store.findBySessionId.mockResolvedValue([]);
    domain.replaceTranscript('session-1', [
      {
        id: 'provider-10',
        source: 'agent',
        timestamp: '2026-07-30T12:00:00.000Z',
        order: 0,
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: 'First' },
        },
      },
      {
        id: 'provider-2',
        source: 'agent',
        timestamp: '2026-07-30T12:00:00.000Z',
        order: 1,
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: 'Second' },
        },
      },
    ]);
    const replaceTranscript = vi.spyOn(domain, 'replaceTranscript');

    await service.hydrate('session-1');

    expect(replaceTranscript).not.toHaveBeenCalled();
    expect(domain.getTranscriptSnapshot('session-1').map((message) => message.id)).toEqual([
      'provider-10',
      'provider-2',
    ]);
  });

  it('logs and leaves the transcript unchanged when lifecycle hydration fails', async () => {
    store.findBySessionId.mockRejectedValue(new Error('database unavailable'));
    const replaceTranscript = vi.spyOn(domain, 'replaceTranscript');

    await service.hydrate('session-1');

    expect(replaceTranscript).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith(
      'Failed hydrating session lifecycle events',
      expect.any(Error),
      { sessionId: 'session-1' }
    );
  });
});
