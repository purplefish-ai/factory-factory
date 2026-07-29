import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStoreRegistry } from './session-store-registry';

describe('SessionStoreRegistry history retry cooldowns', () => {
  let nowMs = Date.parse('2026-02-24T12:00:00.000Z');

  beforeEach(() => {
    nowMs = Date.parse('2026-02-24T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('blocks retry attempts until retry deadline and then allows them', () => {
    const registry = new SessionStoreRegistry();
    registry.setHistoryRetryAt('session-1', nowMs + 30_000);

    expect(registry.canAttemptHistoryHydration('session-1')).toBe(false);

    nowMs += 30_001;
    expect(registry.canAttemptHistoryHydration('session-1')).toBe(true);
  });

  it('removes cooldown entries when a session is cleared', () => {
    const registry = new SessionStoreRegistry();
    registry.setHistoryRetryAt('session-1', nowMs + 30_000);

    expect(registry.canAttemptHistoryHydration('session-1')).toBe(false);

    registry.clearSession('session-1');
    expect(registry.canAttemptHistoryHydration('session-1')).toBe(true);
  });

  it('removes rejection records during a default destructive clear', () => {
    const registry = new SessionStoreRegistry();
    registry.getOrCreate('session-1').recentRejections = [
      {
        id: 'active-rejection',
        errorMessage: 'Runtime crashed',
        rejectedAt: '2026-02-24T12:00:00.000Z',
        expiresAt: nowMs + 30_000,
      },
    ];

    registry.clearSession('session-1');

    expect(registry.getOrCreate('session-1').recentRejections).toEqual([]);
  });

  it('preserves only unexpired rejections in a freshly reset store when requested', () => {
    const registry = new SessionStoreRegistry();
    const store = registry.getOrCreate('session-1');
    const activeRejection = {
      id: 'active-rejection',
      errorMessage: 'Runtime crashed',
      rejectedAt: '2026-02-24T12:00:00.000Z',
      expiresAt: nowMs + 30_000,
    };
    store.initialized = true;
    store.queue.push({
      id: 'queued-message',
      text: 'queued',
      timestamp: '2026-02-24T12:00:00.000Z',
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });
    store.recentRejections = [
      activeRejection,
      {
        id: 'expired-rejection',
        errorMessage: 'Expired',
        rejectedAt: '2026-02-24T11:58:00.000Z',
        expiresAt: nowMs - 1,
      },
    ];
    registry.setHistoryRetryAt('session-1', nowMs + 30_000);

    registry.clearSession('session-1', { preserveRejections: true });

    expect(registry.getOrCreate('session-1')).toMatchObject({
      initialized: false,
      queue: [],
      recentRejections: [activeRejection],
      runtime: {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
      },
    });
    expect(registry.canAttemptHistoryHydration('session-1')).toBe(true);
  });

  it('releases a preservation-only store after its last rejection expires', async () => {
    const registry = new SessionStoreRegistry();
    registry.getOrCreate('session-1').recentRejections = [
      {
        id: 'active-rejection',
        errorMessage: 'Runtime crashed',
        rejectedAt: '2026-02-24T12:00:00.000Z',
        expiresAt: nowMs + 30_000,
      },
    ];
    registry.clearSession('session-1', { preserveRejections: true });

    nowMs += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(registry.getOrCreate('session-1').recentRejections).toEqual([]);
  });

  it('releases a preservation-only store after passive reads', async () => {
    const registry = new SessionStoreRegistry();
    registry.getOrCreate('session-1').recentRejections = [
      {
        id: 'active-rejection',
        errorMessage: 'Runtime crashed',
        rejectedAt: '2026-02-24T12:00:00.000Z',
        expiresAt: nowMs + 30_000,
      },
    ];
    registry.clearSession('session-1', { preserveRejections: true });

    const preservedStore = registry.getOrCreate('session-1');
    expect(registry.getQueueLength('session-1')).toBe(0);

    nowMs += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(registry.getOrCreate('session-1')).not.toBe(preservedStore);
  });

  it('prunes expired rejections without clearing a reactivated store', async () => {
    const registry = new SessionStoreRegistry();
    registry.getOrCreate('session-1').recentRejections = [
      {
        id: 'active-rejection',
        errorMessage: 'Runtime crashed',
        rejectedAt: '2026-02-24T12:00:00.000Z',
        expiresAt: nowMs + 30_000,
      },
    ];
    registry.clearSession('session-1', { preserveRejections: true });

    const reactivatedStore = registry.getOrCreateActive('session-1');
    reactivatedStore.queue.push({
      id: 'new-queued-message',
      text: 'new work',
      timestamp: '2026-02-24T12:00:01.000Z',
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });
    nowMs += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(registry.getOrCreate('session-1')).toBe(reactivatedStore);
    expect(reactivatedStore.queue).toHaveLength(1);
    expect(reactivatedStore.recentRejections).toEqual([]);
  });

  it('removes cooldown entries when all sessions are cleared', () => {
    const registry = new SessionStoreRegistry();
    registry.setHistoryRetryAt('session-1', nowMs + 30_000);
    registry.setHistoryRetryAt('session-2', nowMs + 30_000);

    registry.clearAllSessions();

    expect(registry.canAttemptHistoryHydration('session-1')).toBe(true);
    expect(registry.canAttemptHistoryHydration('session-2')).toBe(true);
  });

  it('evicts the earliest retry deadline when cooldown tracking reaches capacity', () => {
    const registry = new SessionStoreRegistry();

    for (let i = 0; i < 1024; i += 1) {
      registry.setHistoryRetryAt(`session-${i}`, nowMs + i + 1);
    }

    registry.setHistoryRetryAt('session-overflow', nowMs + 50_000);

    expect(registry.canAttemptHistoryHydration('session-0')).toBe(true);
    expect(registry.canAttemptHistoryHydration('session-1')).toBe(false);
    expect(registry.canAttemptHistoryHydration('session-overflow')).toBe(false);
  });
});
