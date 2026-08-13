import { describe, expect, it, vi } from 'vitest';
import type { SessionStartupLease } from './session-lifecycle.types';
import { SessionLifecycleGate, SessionStartupCancelledError } from './session-lifecycle-gate';

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('SessionLifecycleGate', () => {
  it('reuses one generation lease for concurrent startups instead of advancing it', async () => {
    const gate = new SessionLifecycleGate({ isRuntimeStopInProgress: () => false });
    const firstDeferred = createDeferred();
    const secondDeferred = createDeferred();
    let firstLease!: SessionStartupLease;
    let secondLease!: SessionStartupLease;

    const firstStartup = gate.runStartup('session-1', async (lease) => {
      firstLease = lease;
      await firstDeferred.promise;
    });
    const secondStartup = gate.runStartup('session-1', async (lease) => {
      secondLease = lease;
      await secondDeferred.promise;
    });

    expect(secondLease).toEqual(firstLease);
    expect(gate.isGenerationCurrent('session-1', firstLease.generation)).toBe(true);

    firstDeferred.resolve();
    await firstStartup;
    expect(gate.isGenerationCurrent('session-1', secondLease.generation)).toBe(true);

    secondDeferred.resolve();
    await secondStartup;
  });

  it('invalidates an existing startup lease synchronously', async () => {
    const gate = new SessionLifecycleGate({ isRuntimeStopInProgress: () => false });
    let captured!: SessionStartupLease;
    const startup = gate.runStartup('session-1', (lease) => {
      captured = lease;
      return Promise.resolve();
    });
    await startup;

    const stop = gate.reserveStop('session-1');
    expect(stop).not.toBeNull();
    expect(() => gate.assertStartupAllowed(captured)).toThrow(SessionStartupCancelledError);
    expect(() => gate.assertStartupAllowed(captured)).toThrow('Session is currently being stopped');
    stop?.release();
  });

  it('rejects a duplicate reservation instead of releasing the active stop', () => {
    const gate = new SessionLifecycleGate({ isRuntimeStopInProgress: () => false });

    const firstStop = gate.reserveStop('session-1');
    const duplicateStop = gate.reserveStop('session-1');

    expect(firstStop).not.toBeNull();
    expect(duplicateStop).toBeNull();
    expect(gate.isSessionStopping('session-1')).toBe(true);

    firstStop?.release();
    expect(gate.isSessionStopping('session-1')).toBe(false);
  });

  it('keeps a stop reservation released when its finally cleanup runs twice', () => {
    const gate = new SessionLifecycleGate({ isRuntimeStopInProgress: () => false });
    const stop = gate.reserveStop('session-1');

    try {
      expect(gate.isSessionStopping('session-1')).toBe(true);
    } finally {
      stop?.release();
      stop?.release();
    }

    expect(gate.isSessionStopping('session-1')).toBe(false);
    expect(gate.isGenerationCurrent('session-1', stop?.generation ?? -1)).toBe(false);
  });

  it('removes a failed startup lease instead of retaining its generation', async () => {
    const gate = new SessionLifecycleGate({ isRuntimeStopInProgress: () => false });
    const failedGeneration = gate.getGeneration('session-1');

    await expect(
      gate.runStartup('session-1', () => Promise.reject(new Error('spawn failed')))
    ).rejects.toThrow('spawn failed');

    const sentinelGeneration = gate.getGeneration('sentinel-session');
    const nextGeneration = gate.getGeneration('session-1');
    expect(sentinelGeneration).toBeGreaterThan(failedGeneration);
    expect(nextGeneration).toBeGreaterThan(sentinelGeneration);
  });

  it('does not remove a failed lease while a concurrent startup still references it', async () => {
    const gate = new SessionLifecycleGate({ isRuntimeStopInProgress: () => false });
    const deferred = createDeferred();
    let retainedLease!: SessionStartupLease;

    const retainedStartup = gate.runStartup('session-1', async (lease) => {
      retainedLease = lease;
      await deferred.promise;
    });
    await expect(
      gate.runStartup('session-1', () => Promise.reject(new Error('startup failed')))
    ).rejects.toThrow('startup failed');

    expect(gate.isGenerationCurrent('session-1', retainedLease.generation)).toBe(true);

    deferred.resolve();
    await retainedStartup;
  });

  it('retains a successful generation when a failing sibling releases last', async () => {
    const gate = new SessionLifecycleGate({ isRuntimeStopInProgress: () => false });
    const successfulDeferred = createDeferred();
    let rejectFailure!: (reason?: unknown) => void;
    const failureBoundary = new Promise<void>((_resolve, reject) => {
      rejectFailure = reject;
    });
    let successfulLease!: SessionStartupLease;
    let failingLease!: SessionStartupLease;

    const successfulStartup = gate.runStartup('session-1', async (lease) => {
      successfulLease = lease;
      await successfulDeferred.promise;
    });
    const failingStartup = gate.runStartup('session-1', async (lease) => {
      failingLease = lease;
      await failureBoundary;
    });

    expect(failingLease).toEqual(successfulLease);
    successfulDeferred.resolve();
    await successfulStartup;
    rejectFailure(new Error('sibling failed'));
    await expect(failingStartup).rejects.toThrow('sibling failed');

    expect(gate.isGenerationCurrent('session-1', successfulLease.generation)).toBe(true);
  });

  it('retains an established generation when a later startup fails', async () => {
    const gate = new SessionLifecycleGate({ isRuntimeStopInProgress: () => false });
    let establishedLease!: SessionStartupLease;

    await gate.runStartup('session-1', (lease) => {
      establishedLease = lease;
      return Promise.resolve();
    });
    await expect(
      gate.runStartup('session-1', () => Promise.reject(new Error('duplicate startup')))
    ).rejects.toThrow('duplicate startup');

    expect(gate.isGenerationCurrent('session-1', establishedLease.generation)).toBe(true);
  });

  it('reserves shutdown sessions instead of allowing their startup leases to continue', async () => {
    const gate = new SessionLifecycleGate({ isRuntimeStopInProgress: () => false });
    let firstLease!: SessionStartupLease;
    let secondLease!: SessionStartupLease;
    await Promise.all([
      gate.runStartup('session-1', (lease) => {
        firstLease = lease;
        return Promise.resolve();
      }),
      gate.runStartup('session-2', (lease) => {
        secondLease = lease;
        return Promise.resolve();
      }),
    ]);

    gate.reserveShutdown(['session-1', 'session-2']);

    expect(gate.isSessionStopping('session-1')).toBe(true);
    expect(gate.isSessionStopping('session-2')).toBe(true);
    expect(() => gate.assertStartupAllowed(firstLease)).toThrow(SessionStartupCancelledError);
    expect(() => gate.assertStartupAllowed(secondLease)).toThrow(SessionStartupCancelledError);

    gate.releaseShutdown('session-1');
    gate.releaseShutdown('session-2');
    expect(gate.isSessionStopping('session-1')).toBe(false);
    expect(gate.isSessionStopping('session-2')).toBe(false);
  });

  it('includes the injected runtime stop query instead of owning runtime state', async () => {
    const isRuntimeStopInProgress = vi.fn(() => false);
    const gate = new SessionLifecycleGate({ isRuntimeStopInProgress });
    let lease!: SessionStartupLease;
    await gate.runStartup('session-1', (startupLease) => {
      lease = startupLease;
      return Promise.resolve();
    });

    isRuntimeStopInProgress.mockReturnValue(true);

    expect(gate.isSessionStopping('session-1')).toBe(true);
    expect(isRuntimeStopInProgress).toHaveBeenCalledWith('session-1');
    expect(() => gate.assertStartupAllowed(lease)).toThrow(SessionStartupCancelledError);
  });
});
