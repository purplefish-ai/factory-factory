import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRFetchCoordinator } from './pr-fetch-coordinator';

const COOLDOWN_MS = 90_000;
const IN_FLIGHT_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 1024;

/** A fetch the test can hold open, so a claim can be observed while in flight. */
function deferredFetch(): {
  fetch: () => Promise<string>;
  resolve: () => void;
  reject: () => void;
} {
  let settle!: (value: string) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<string>((resolveFn, rejectFn) => {
    settle = resolveFn;
    fail = rejectFn;
  });
  return {
    fetch: () => promise,
    resolve: () => {
      settle('fetched');
    },
    reject: () => {
      fail(new Error('boom'));
    },
  };
}

describe('PRFetchCoordinator', () => {
  let coordinator: PRFetchCoordinator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    coordinator = new PRFetchCoordinator();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('running the fetch', () => {
    it('runs the fetch and returns its value', async () => {
      const fetch = vi.fn(() => Promise.resolve('value'));

      await expect(coordinator.coordinate('ws-1', fetch)).resolves.toEqual({
        status: 'fetched',
        value: 'value',
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('propagates a rejection instead of swallowing it', async () => {
      await expect(
        coordinator.coordinate('ws-1', () => Promise.reject(new Error('boom')))
      ).rejects.toThrow('boom');
    });

    it('claims the workspace before the fetch is awaited', () => {
      const deferred = deferredFetch();
      const second = vi.fn(() => Promise.resolve('second'));

      // Deliberately not awaited: the point is that the claim is visible to a
      // caller that arrives before the first fetch has yielded.
      void coordinator.coordinate('ws-1', deferred.fetch);
      void coordinator.coordinate('ws-1', second);

      expect(second).not.toHaveBeenCalled();
      deferred.resolve();
    });
  });

  describe('skipping', () => {
    it('skips a workspace whose fetch is still in flight', async () => {
      const deferred = deferredFetch();
      const first = coordinator.coordinate('ws-1', deferred.fetch);

      const second = vi.fn(() => Promise.resolve('second'));
      await expect(coordinator.coordinate('ws-1', second)).resolves.toEqual({
        status: 'skipped',
        reason: 'recently_fetched',
      });
      expect(second).not.toHaveBeenCalled();

      deferred.resolve();
      await first;
    });

    it('does not skip a different workspace', async () => {
      const deferred = deferredFetch();
      const first = coordinator.coordinate('ws-1', deferred.fetch);

      const other = vi.fn(() => Promise.resolve('other'));
      await expect(coordinator.coordinate('ws-2', other)).resolves.toEqual({
        status: 'fetched',
        value: 'other',
      });

      deferred.resolve();
      await first;
    });

    it('skips within the default cooldown and runs once it has elapsed', async () => {
      await coordinator.coordinate('ws-1', () => Promise.resolve('first'));

      vi.advanceTimersByTime(COOLDOWN_MS - 1);
      const suppressed = vi.fn(() => Promise.resolve('suppressed'));
      await expect(coordinator.coordinate('ws-1', suppressed)).resolves.toMatchObject({
        status: 'skipped',
      });
      expect(suppressed).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      await expect(
        coordinator.coordinate('ws-1', () => Promise.resolve('second'))
      ).resolves.toEqual({ status: 'fetched', value: 'second' });
    });

    it('honors a longer custom cooldown after the default one expires', async () => {
      await coordinator.coordinate('ws-1', () => Promise.resolve('first'));

      vi.advanceTimersByTime(COOLDOWN_MS);

      await expect(
        coordinator.coordinate('ws-1', () => Promise.resolve('default'), {})
      ).resolves.toMatchObject({ status: 'fetched' });

      vi.advanceTimersByTime(COOLDOWN_MS);
      await expect(
        coordinator.coordinate('ws-1', () => Promise.resolve('custom'), { cooldownMs: 120_000 })
      ).resolves.toMatchObject({ status: 'skipped' });
    });
  });

  describe('ignoreCooldown', () => {
    it('runs despite a recent completed fetch', async () => {
      await coordinator.coordinate('ws-1', () => Promise.resolve('first'));

      await expect(
        coordinator.coordinate('ws-1', () => Promise.resolve('second'), { ignoreCooldown: true })
      ).resolves.toEqual({ status: 'fetched', value: 'second' });
    });

    it('still defers to a fetch that is actively in flight', async () => {
      const deferred = deferredFetch();
      const first = coordinator.coordinate('ws-1', deferred.fetch);

      const second = vi.fn(() => Promise.resolve('second'));
      await expect(
        coordinator.coordinate('ws-1', second, { ignoreCooldown: true })
      ).resolves.toMatchObject({ status: 'skipped' });
      expect(second).not.toHaveBeenCalled();

      deferred.resolve();
      await first;
    });
  });

  describe('countsAsFetched', () => {
    it('does not start a cooldown when the value reports failure', async () => {
      await coordinator.coordinate('ws-1', () => Promise.resolve({ success: false }), {
        countsAsFetched: (value) => value.success,
      });

      expect(coordinator.size()).toEqual({ completed: 0, inFlight: 0 });
      await expect(
        coordinator.coordinate('ws-1', () => Promise.resolve({ success: true }))
      ).resolves.toMatchObject({ status: 'fetched' });
    });

    it('starts a cooldown when the value reports success', async () => {
      await coordinator.coordinate('ws-1', () => Promise.resolve({ success: true }), {
        countsAsFetched: (value) => value.success,
      });

      expect(coordinator.size()).toEqual({ completed: 1, inFlight: 0 });
    });

    it('leaves no cooldown behind when the fetch throws', async () => {
      await expect(
        coordinator.coordinate('ws-1', () => Promise.reject(new Error('boom')))
      ).rejects.toThrow('boom');

      expect(coordinator.size()).toEqual({ completed: 0, inFlight: 0 });
      await expect(coordinator.coordinate('ws-1', () => Promise.resolve('retry'))).resolves.toEqual(
        { status: 'fetched', value: 'retry' }
      );
    });

    it('releases the claim when the fetch throws', async () => {
      const deferred = deferredFetch();
      const failing = coordinator.coordinate('ws-1', deferred.fetch);
      deferred.reject();
      await expect(failing).rejects.toThrow('boom');

      expect(coordinator.size()).toEqual({ completed: 0, inFlight: 0 });
    });
  });

  describe('retention', () => {
    it('removes completed and in-flight entries for one workspace', async () => {
      await coordinator.coordinate('ws-1', () => Promise.resolve('done'));
      const deferred = deferredFetch();
      const inFlight = coordinator.coordinate('ws-2', deferred.fetch);

      coordinator.removeWorkspace('ws-1');
      coordinator.removeWorkspace('ws-2');

      expect(coordinator.size()).toEqual({ completed: 0, inFlight: 0 });
      deferred.resolve();
      await inFlight;
    });

    it('allows missing and repeated workspace removal', () => {
      expect(() => coordinator.removeWorkspace('missing')).not.toThrow();
      expect(() => coordinator.removeWorkspace('missing')).not.toThrow();
      expect(coordinator.size()).toEqual({ completed: 0, inFlight: 0 });
    });

    it('does not record a completion after workspace cleanup', async () => {
      const deferred = deferredFetch();
      const pending = coordinator.coordinate('ws-1', deferred.fetch);
      coordinator.removeWorkspace('ws-1');

      deferred.resolve();
      await pending;

      expect(coordinator.size()).toEqual({ completed: 0, inFlight: 0 });
    });

    it('expires an abandoned in-flight claim', async () => {
      const deferred = deferredFetch();
      const abandoned = coordinator.coordinate('ws-1', deferred.fetch);

      vi.advanceTimersByTime(IN_FLIGHT_TTL_MS);

      const replacement = vi.fn(() => Promise.resolve('replacement'));
      await expect(coordinator.coordinate('ws-1', replacement)).resolves.toEqual({
        status: 'fetched',
        value: 'replacement',
      });

      deferred.resolve();
      await abandoned;
    });

    it('keeps the newer claim when an expired one settles late', async () => {
      const abandonedFetch = deferredFetch();
      const abandoned = coordinator.coordinate('ws-1', abandonedFetch.fetch);

      vi.advanceTimersByTime(IN_FLIGHT_TTL_MS);

      const replacementFetch = deferredFetch();
      const replacement = coordinator.coordinate('ws-1', replacementFetch.fetch);

      // The abandoned claim settling must not free the slot the replacement holds.
      abandonedFetch.resolve();
      await abandoned;
      expect(coordinator.size()).toEqual({ completed: 0, inFlight: 1 });

      replacementFetch.resolve();
      await replacement;
      expect(coordinator.size()).toEqual({ completed: 1, inFlight: 0 });
    });

    it('evicts the oldest workspace when capacity is reached', async () => {
      await coordinator.coordinate('oldest-completed', () => Promise.resolve('done'));

      const held = [];
      for (let index = 0; index < MAX_ENTRIES; index += 1) {
        vi.advanceTimersByTime(1);
        const deferred = deferredFetch();
        held.push({
          deferred,
          pending: coordinator.coordinate(`in-flight-${index}`, deferred.fetch),
        });
      }

      expect(coordinator.size()).toEqual({ completed: 0, inFlight: MAX_ENTRIES });

      for (const { deferred, pending } of held) {
        deferred.resolve();
        await pending;
      }
    });
  });
});
