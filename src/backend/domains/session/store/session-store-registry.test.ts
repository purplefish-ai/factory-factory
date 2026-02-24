import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStoreRegistry } from './session-store-registry';

describe('SessionStoreRegistry history retry cooldowns', () => {
  let nowMs = Date.parse('2026-02-24T12:00:00.000Z');

  beforeEach(() => {
    nowMs = Date.parse('2026-02-24T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
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
