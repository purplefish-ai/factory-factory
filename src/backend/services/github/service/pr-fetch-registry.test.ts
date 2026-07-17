import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRFetchRegistry } from './pr-fetch-registry';

const COOLDOWN_MS = 90_000;
const IN_FLIGHT_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 1024;

describe('PRFetchRegistry', () => {
  let registry: PRFetchRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    registry = new PRFetchRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes completed and in-flight entries for one workspace', () => {
    registry.startFetch('ws-1');
    registry.register('ws-1');
    registry.startFetch('ws-2');

    registry.removeWorkspace('ws-1');
    registry.removeWorkspace('ws-2');

    expect(registry.size()).toEqual({ completed: 0, inFlight: 0 });
  });

  it('does not record a completion after workspace cleanup', () => {
    registry.startFetch('ws-1');
    registry.removeWorkspace('ws-1');

    registry.register('ws-1');

    expect(registry.size()).toEqual({ completed: 0, inFlight: 0 });
  });

  it('allows missing and repeated workspace removal', () => {
    expect(() => registry.removeWorkspace('missing')).not.toThrow();

    registry.startFetch('ws-1');
    registry.removeWorkspace('ws-1');
    registry.removeWorkspace('ws-1');

    expect(registry.size()).toEqual({ completed: 0, inFlight: 0 });
  });

  it('returns false after the default cooldown without deleting the timestamp', () => {
    registry.startFetch('ws-1');
    registry.register('ws-1');

    vi.advanceTimersByTime(COOLDOWN_MS);

    expect(registry.isRecentlyFetched('ws-1')).toBe(false);
    expect(registry.size()).toEqual({ completed: 1, inFlight: 0 });
  });

  it('honors a longer custom cooldown after an unrelated registry operation', () => {
    registry.startFetch('ws-1');
    registry.register('ws-1');

    vi.advanceTimersByTime(COOLDOWN_MS);
    registry.startFetch('ws-2');

    expect(registry.isRecentlyFetched('ws-1', 120_000)).toBe(true);
  });

  it('keeps a default-expired timestamp available to a longer custom cooldown', () => {
    registry.startFetch('ws-1');
    registry.register('ws-1');

    vi.advanceTimersByTime(COOLDOWN_MS);

    expect(registry.isRecentlyFetched('ws-1')).toBe(false);
    expect(registry.isRecentlyFetched('ws-1', 120_000)).toBe(true);
  });

  it('expires abandoned in-flight entries', () => {
    registry.startFetch('ws-1');

    vi.advanceTimersByTime(IN_FLIGHT_TTL_MS);

    expect(registry.isFetchInFlight('ws-1')).toBe(false);
    expect(registry.size()).toEqual({ completed: 0, inFlight: 0 });
  });

  it('evicts the oldest workspace when capacity is reached', () => {
    registry.startFetch('oldest-completed');
    registry.register('oldest-completed');

    for (let index = 0; index < MAX_ENTRIES; index += 1) {
      vi.advanceTimersByTime(1);
      registry.startFetch(`in-flight-${index}`);
    }

    expect(registry.isRecentlyFetched('oldest-completed')).toBe(false);
    expect(registry.isFetchInFlight('in-flight-0')).toBe(true);
    expect(registry.size()).toEqual({ completed: 0, inFlight: MAX_ENTRIES });
  });

  it('reuses a workspace after cleanup', () => {
    registry.startFetch('ws-1');
    registry.removeWorkspace('ws-1');

    registry.startFetch('ws-1');
    registry.register('ws-1');

    expect(registry.isRecentlyFetched('ws-1')).toBe(true);
    expect(registry.size()).toEqual({ completed: 1, inFlight: 0 });
  });
});
