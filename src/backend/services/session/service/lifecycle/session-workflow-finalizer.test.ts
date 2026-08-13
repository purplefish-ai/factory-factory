import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { workspaceDataService } from '@/backend/services/workspace';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionLifecycleService } from './session.lifecycle.service';
import { createLifecycleHarness } from './session-lifecycle.test-helpers';
import { SessionLifecycleEventService } from './session-lifecycle-event.service';

vi.mock('./closed-session-persistence.service', () => ({
  closedSessionPersistenceService: {
    persistClosedSession: vi.fn(async () => undefined),
  },
}));

import { closedSessionPersistenceService } from './closed-session-persistence.service';

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getCurrentProcessEnv: () => ({ NODE_ENV: 'test' }),
}));

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: { findById: vi.fn() },
  workspaceNotificationService: {
    listPendingForDelivery: vi.fn(),
    markDelivered: vi.fn(),
  },
}));

describe('SessionWorkflowFinalizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hydrates durable lifecycle rows before persisting a closed transcript', async () => {
    const domain = new SessionDomainService();
    const hydrateProviderHistory = vi.fn(() => {
      domain.replaceTranscript('session-1', [
        {
          id: 'provider-user-1',
          source: 'user',
          text: 'Original provider conversation',
          timestamp: '2026-07-30T12:00:00.000Z',
          order: 0,
        },
      ]);
      return Promise.resolve();
    });
    const lifecycleEventService = new SessionLifecycleEventService({
      store: {
        upsert: vi.fn(),
        findBySessionId: vi.fn(async () => [
          {
            id: 'event-1',
            workspaceId: 'workspace-1',
            sessionId: 'session-1',
            kind: 'TURN_INTERRUPTED',
            reason: 'PROMPT_TIMEOUT',
            message: 'Turn stopped: reached the 4-hour limit.',
            dedupeKey: 'prompt-timeout',
            createdAt: new Date('2026-07-30T12:22:23.353Z'),
          },
        ]),
      } as never,
      sessionDomainService: domain,
    });
    const hydrateLifecycleEvents = vi.spyOn(lifecycleEventService, 'hydrate');
    domain.clearSession('session-1');
    const repository = {
      getSessionById: vi.fn(async () => ({
        id: 'session-1',
        workspaceId: 'workspace-1',
        name: 'Chat',
        workflow: 'user',
        provider: 'CLAUDE',
        model: 'claude-sonnet',
        createdAt: new Date('2026-07-30T12:00:00.000Z'),
      })),
    };
    vi.mocked(workspaceDataService.findById).mockResolvedValue({
      id: 'workspace-1',
      worktreePath: '/tmp/worktree',
    } as never);
    const service = new SessionLifecycleService(
      unsafeCoerce({
        repository,
        promptBuilder: {},
        runtimeManager: {},
        sessionDomainService: domain,
        sessionPermissionService: {},
        sessionConfigService: {},
        acpEventProcessor: {},
        promptTurnCompletionService: {},
        retryService: {},
        sendSessionMessage: vi.fn(),
        lifecycleEventService,
        hydrateProviderHistory,
      })
    );

    await service.persistClosedSession('session-1');

    expect(closedSessionPersistenceService.persistClosedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        messages: expect.arrayContaining([
          expect.objectContaining({ id: 'provider-user-1' }),
          expect.objectContaining({ id: 'session-lifecycle:event-1' }),
        ]),
      })
    );
    expect(hydrateProviderHistory).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ provider: 'CLAUDE' })
    );
    expect(hydrateProviderHistory.mock.invocationCallOrder[0]).toBeLessThan(
      hydrateLifecycleEvents.mock.invocationCallOrder[0]!
    );
  });

  it('repeats closed-session finalization with the same durable transcript', async () => {
    vi.mocked(workspaceDataService.findById).mockResolvedValue({
      id: 'workspace-1',
      worktreePath: '/tmp/worktree',
    } as never);
    const transcript = [
      {
        id: 'user-1',
        source: 'user' as const,
        text: 'Keep this transcript durable.',
        timestamp: '2026-07-30T12:00:00.000Z',
        order: 0,
      },
    ];
    const harness = createLifecycleHarness({ transcript });

    await harness.service.persistClosedSession('session-1');
    await harness.service.persistClosedSession('session-1');

    expect(harness.lifecycleEventService.hydrate).toHaveBeenCalledTimes(2);
    expect(closedSessionPersistenceService.persistClosedSession).toHaveBeenCalledTimes(2);
    expect(closedSessionPersistenceService.persistClosedSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: 'session-1', messages: transcript })
    );
    expect(closedSessionPersistenceService.persistClosedSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: 'session-1', messages: transcript })
    );
  });
});
