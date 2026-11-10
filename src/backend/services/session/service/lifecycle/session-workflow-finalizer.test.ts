import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { PersistClosedSessionInput } from '@/backend/services/session/service/archive/closed-session-persistence.service';
import {
  createLifecycleTestSession,
  createLifecycleTestWorkspace,
} from './session-lifecycle.test-helpers';
import { SessionWorkflowFinalizer } from './session-workflow-finalizer';

type FinalizerHarness = ReturnType<typeof createFinalizerHarness>;

function createFinalizerHarness(options?: {
  session?: AgentSessionRecord | null;
  workspace?: ReturnType<typeof createLifecycleTestWorkspace> | null;
  running?: boolean;
  viewerCount?: number;
  queueLength?: number;
}) {
  const session = options?.session === undefined ? createLifecycleTestSession() : options.session;
  const workspace =
    options?.workspace === undefined ? createLifecycleTestWorkspace() : options.workspace;
  const repository = {
    getSessionById: vi.fn(async () => session),
    deleteSession: vi.fn(async () => createLifecycleTestSession()),
    recoverStaleRunningSessions: vi.fn(async () => 2),
  };
  const workspaceLookup = {
    findById: vi.fn(async () => workspace),
  };
  const domain = {
    getTranscriptSnapshot: vi.fn(() => [
      {
        id: 'user-1',
        source: 'user' as const,
        text: 'Keep this transcript durable.',
        timestamp: '2026-07-30T12:00:00.000Z',
        order: 0,
      },
    ]),
    clearSession: vi.fn(),
    getQueueLength: vi.fn(() => options?.queueLength ?? 0),
    getHistoryHydrationSource: vi.fn(() => undefined),
  };
  const persistence = {
    persistClosedSession: vi.fn<(input: PersistClosedSessionInput) => Promise<void>>(
      async () => undefined
    ),
  };
  const lifecycleEvents = {
    hydrate: vi.fn(async () => undefined),
  };
  const hydrateProviderHistory = vi.fn(async () => undefined);
  const runtime = {
    isSessionRunning: vi.fn(() => options?.running ?? false),
    hasObservedEmptyProviderSession: vi.fn(() => false),
    isStopInProgress: vi.fn(() => false),
  };
  const viewerCount = vi.fn(() => options?.viewerCount ?? 0);
  const workspaceBridge = {
    markSessionRunning: vi.fn(() => 0),
    markSessionIdle: vi.fn(),
    resetPRDiscoveryBackoff: vi.fn(async () => true),
  };
  const autoIterationExit = {
    onAutoIterationSessionExit: vi.fn(),
  };
  const finalizer = new SessionWorkflowFinalizer({
    repository,
    workspaceLookup,
    sessionDomainService: domain,
    closedSessionPersistenceService: persistence,
    lifecycleEventService: lifecycleEvents,
    hydrateProviderHistory,
    runtimeManager: runtime,
    countViewers: viewerCount,
  });
  // Stale callers cannot revive the former finalization callback.
  const legacyBridges = { workspace: workspaceBridge, autoIterationExit };
  finalizer.configure(legacyBridges);

  return {
    finalizer,
    repository,
    workspaceLookup,
    domain,
    persistence,
    lifecycleEvents,
    hydrateProviderHistory,
    runtime,
    viewerCount,
    workspaceBridge,
    autoIterationExit,
    session,
  };
}

describe('SessionWorkflowFinalizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hydrates provider and lifecycle history before persisting a closed transcript', async () => {
    const harness = createFinalizerHarness();

    await harness.finalizer.persistClosedSession('session-1');

    expect(harness.hydrateProviderHistory).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        id: 'session-1',
        workspace: { worktreePath: '/tmp/workspace' },
      })
    );
    expect(harness.hydrateProviderHistory.mock.invocationCallOrder[0]).toBeLessThan(
      harness.lifecycleEvents.hydrate.mock.invocationCallOrder[0]!
    );
    expect(harness.lifecycleEvents.hydrate.mock.invocationCallOrder[0]).toBeLessThan(
      harness.persistence.persistClosedSession.mock.invocationCallOrder[0]!
    );
    expect(harness.persistence.persistClosedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        worktreePath: '/tmp/workspace',
        messages: [
          expect.objectContaining({
            id: 'user-1',
            text: 'Keep this transcript durable.',
          }),
        ],
      })
    );
  });

  it.each([
    ['missing session', { session: null }],
    ['missing worktree', { workspace: createLifecycleTestWorkspace({ worktreePath: null }) }],
  ] as const)('skips closed persistence for a %s', async (_caseName, options) => {
    const harness = createFinalizerHarness(options);

    await harness.finalizer.persistClosedSession('session-1');

    expect(harness.hydrateProviderHistory).not.toHaveBeenCalled();
    expect(harness.lifecycleEvents.hydrate).not.toHaveBeenCalled();
    expect(harness.persistence.persistClosedSession).not.toHaveBeenCalled();
  });

  it('removes the transient session after a deliberate ratchet stop', async () => {
    const harness = createFinalizerHarness({
      session: createLifecycleTestSession({ workflow: 'ratchet' }),
    });

    await harness.finalizer.finalizeDeliberateStop({
      session: harness.session,
      sessionId: 'session-1',
      cleanupTransientRatchetSession: true,
    });

    expect(harness.persistence.persistClosedSession).toHaveBeenCalledOnce();
    expect(harness.repository.deleteSession).toHaveBeenCalledWith('session-1');
    expect(harness.domain.clearSession).toHaveBeenCalledWith('session-1', {
      permanentlyDeleted: true,
    });
  });

  it('keeps deliberate stop cleanup best effort when transient persistence or deletion fails', async () => {
    const harness = createFinalizerHarness({
      session: createLifecycleTestSession({ workflow: 'ratchet' }),
    });
    harness.persistence.persistClosedSession.mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(
      harness.finalizer.finalizeDeliberateStop({
        session: harness.session,
        sessionId: 'session-1',
        cleanupTransientRatchetSession: true,
      })
    ).resolves.toBeUndefined();
    expect(harness.repository.deleteSession).not.toHaveBeenCalled();

    harness.persistence.persistClosedSession.mockResolvedValueOnce(undefined);
    harness.repository.deleteSession.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      harness.finalizer.finalizeDeliberateStop({
        session: harness.session,
        sessionId: 'session-1',
        cleanupTransientRatchetSession: true,
      })
    ).resolves.toBeUndefined();
    expect(harness.persistence.persistClosedSession).toHaveBeenCalledTimes(2);
    expect(harness.domain.clearSession).not.toHaveBeenCalled();
  });

  it('cleans up a transient ratchet session on runtime exit', async () => {
    const harness = createFinalizerHarness({
      session: createLifecycleTestSession({ workflow: 'ratchet' }),
    });

    await expect(
      harness.finalizer.finalizeRuntimeExit({
        session: harness.session!,
        sessionId: 'session-1',
        exitCode: 1,
        deliberate: false,
      })
    ).resolves.toBeUndefined();

    expect(harness.persistence.persistClosedSession).toHaveBeenCalledOnce();
    expect(harness.repository.deleteSession).toHaveBeenCalledWith('session-1');
    expect(harness.domain.clearSession).toHaveBeenCalledWith('session-1', {
      permanentlyDeleted: true,
    });
  });

  it('keeps legacy sessions and transcripts intact without notifying a loop', async () => {
    const harness = createFinalizerHarness({
      session: createLifecycleTestSession({ workflow: 'auto-iteration' }),
    });

    await harness.finalizer.finalizeRuntimeExit({
      session: harness.session!,
      sessionId: 'session-1',
      exitCode: 0,
      deliberate: true,
    });
    await harness.finalizer.finalizeRuntimeExit({
      session: harness.session!,
      sessionId: 'session-1',
      exitCode: 1,
      deliberate: false,
    });

    expect(harness.autoIterationExit.onAutoIterationSessionExit).not.toHaveBeenCalled();
    expect(harness.repository.deleteSession).not.toHaveBeenCalled();
    expect(harness.domain.clearSession).not.toHaveBeenCalled();
    expect(harness.workspaceBridge.resetPRDiscoveryBackoff).toHaveBeenCalledWith('workspace-1');
  });

  it('schedules PR discovery after a runtime exit without delaying finalization', async () => {
    const harness = createFinalizerHarness();

    await harness.finalizer.finalizeRuntimeExit({
      session: harness.session!,
      sessionId: 'session-1',
      exitCode: 0,
      deliberate: false,
    });

    expect(harness.workspaceBridge.resetPRDiscoveryBackoff).toHaveBeenCalledWith('workspace-1');
  });

  it('retains inactive in-memory session state while a viewer is attached', () => {
    const harness = createFinalizerHarness({ viewerCount: 1 });

    harness.finalizer.clearInactiveSession('session-1', 'manual_stop');

    expect(harness.domain.clearSession).not.toHaveBeenCalled();
  });

  it('persists a transient ratchet session once when deliberate finalization retries deletion', async () => {
    const harness = createFinalizerHarness({
      session: createLifecycleTestSession({ workflow: 'ratchet' }),
    });
    harness.repository.deleteSession.mockRejectedValueOnce(new Error('delete failed'));

    await harness.finalizer.finalizeDeliberateStop({
      session: harness.session,
      sessionId: 'session-1',
      cleanupTransientRatchetSession: true,
    });
    await harness.finalizer.finalizeDeliberateStop({
      session: harness.session,
      sessionId: 'session-1',
      cleanupTransientRatchetSession: true,
    });

    expect(harness.persistence.persistClosedSession).toHaveBeenCalledOnce();
    expect(harness.repository.deleteSession).toHaveBeenCalledTimes(2);
    expect(harness.domain.clearSession).toHaveBeenCalledOnce();
  });

  it('clears transient state when ratchet deletion reports an externally missing session', async () => {
    const harness = createFinalizerHarness({
      session: createLifecycleTestSession({ workflow: 'ratchet' }),
    });
    harness.repository.deleteSession.mockRejectedValueOnce(
      Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' })
    );

    await harness.finalizer.finalizeDeliberateStop({
      session: harness.session,
      sessionId: 'session-1',
      cleanupTransientRatchetSession: true,
    });

    expect(harness.persistence.persistClosedSession).toHaveBeenCalledOnce();
    expect(harness.repository.deleteSession).toHaveBeenCalledOnce();
    expect(harness.domain.clearSession).toHaveBeenCalledWith('session-1', {
      permanentlyDeleted: true,
    });
  });

  it('keeps a transient ratchet session retryable when persistence reports it missing', async () => {
    const harness = createFinalizerHarness({
      session: createLifecycleTestSession({ workflow: 'ratchet' }),
    });
    harness.persistence.persistClosedSession.mockRejectedValueOnce(new Error('Session not found'));

    await harness.finalizer.finalizeDeliberateStop({
      session: harness.session,
      sessionId: 'session-1',
      cleanupTransientRatchetSession: true,
    });
    await harness.finalizer.finalizeDeliberateStop({
      session: harness.session,
      sessionId: 'session-1',
      cleanupTransientRatchetSession: true,
    });

    expect(harness.persistence.persistClosedSession).toHaveBeenCalledTimes(2);
    expect(harness.repository.deleteSession).toHaveBeenCalledOnce();
    expect(harness.domain.clearSession).toHaveBeenCalledOnce();
  });

  it('retains a legacy fixer when its closed transcript cannot be archived', async () => {
    const harness = createFinalizerHarness({
      session: createLifecycleTestSession({ workflow: 'ratchet' }),
      workspace: null,
    });
    await harness.finalizer.finalizeDeliberateStop({
      session: harness.session,
      sessionId: 'session-1',
      cleanupTransientRatchetSession: true,
    });
    expect(harness.repository.deleteSession).not.toHaveBeenCalled();
  });

  it('delegates stale-running recovery to the session repository', async () => {
    const harness: FinalizerHarness = createFinalizerHarness();

    await expect(harness.finalizer.recoverStaleRunningSessions()).resolves.toBe(2);

    expect(harness.repository.recoverStaleRunningSessions).toHaveBeenCalledOnce();
  });
});

it.each([
  { running: false, viewerCount: 0, queueLength: 1, evict: false },
  { running: false, viewerCount: 0, queueLength: 0, evict: true },
  { running: true, viewerCount: 0, queueLength: 0, evict: false },
  { running: false, viewerCount: 1, queueLength: 0, evict: false },
])('evicts only inactive unviewed stores without queued input: %o', (options) => {
  const h = createFinalizerHarness(options);
  h.finalizer.clearInactiveSession('session-1', 'runtime_exit');
  expect(h.domain.clearSession).toHaveBeenCalledTimes(options.evict ? 1 : 0);
});
