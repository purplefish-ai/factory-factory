import { describe, expect, it, vi } from 'vitest';
import { AcpRuntimeQuiescence } from './acp-runtime-quiescence';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('AcpRuntimeQuiescence', () => {
  it('keeps a synchronously registered creation operation until its result resolves', async () => {
    // Catches removing a creation barrier before its operation settles.
    const result = createDeferred<string>();
    const quiescence = new AcpRuntimeQuiescence({
      stopClient: vi.fn().mockResolvedValue(undefined),
    });

    const operation = quiescence.runClientCreationOperation(
      'session-1',
      'active',
      (registration) => {
        expect(registration.isOnlyOperation()).toBe(true);
        expect(quiescence.getTrackedSessionIds()).toEqual(['session-1']);
        expect(quiescence.isBrowseOnlySession('session-1')).toBe(false);
        return result.promise;
      }
    );

    result.resolve('created');

    await expect(operation).resolves.toBe('created');
    expect(quiescence.getTrackedSessionIds()).toEqual([]);
  });

  it('unregisters a rejected creation operation', async () => {
    // Catches leaving a rejected creation barrier tracked forever.
    const quiescence = new AcpRuntimeQuiescence({
      stopClient: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      quiescence.runClientCreationOperation('session-1', 'browse', () =>
        Promise.reject(new Error('reconciliation failed'))
      )
    ).rejects.toThrow('reconciliation failed');

    expect(quiescence.getTrackedSessionIds()).toEqual([]);
    expect(quiescence.isBrowseOnlySession('session-1')).toBe(false);
  });

  it('reports only-operation state across concurrent same-session creation operations', async () => {
    // Catches treating every same-session creation operation as the only operation.
    const first = createDeferred<void>();
    const second = createDeferred<void>();
    const quiescence = new AcpRuntimeQuiescence({
      stopClient: vi.fn().mockResolvedValue(undefined),
    });
    let firstRegistration: { isOnlyOperation(): boolean } | undefined;

    const firstOperation = quiescence.runClientCreationOperation(
      'session-1',
      'browse',
      (registration) => {
        firstRegistration = registration;
        return first.promise;
      }
    );
    const secondOperation = quiescence.runClientCreationOperation(
      'session-1',
      'browse',
      (registration) => {
        expect(registration.isOnlyOperation()).toBe(false);
        return second.promise;
      }
    );

    expect(firstRegistration?.isOnlyOperation()).toBe(false);
    expect(quiescence.isBrowseOnlySession('session-1')).toBe(true);
    first.resolve();
    second.resolve();

    await Promise.all([firstOperation, secondOperation]);
  });

  it('stops before and after a pending creation operation settles', async () => {
    // Catches skipping the post-creation stop that closes a reconciliation race.
    const pending = createDeferred<void>();
    const stopClient = vi.fn().mockResolvedValue(undefined);
    const quiescence = new AcpRuntimeQuiescence({ stopClient });
    const creation = quiescence.runClientCreationOperation(
      'session-1',
      'active',
      () => pending.promise
    );

    const stop = quiescence.stopAndQuiesce('session-1');
    await vi.waitFor(() => expect(stopClient).toHaveBeenCalledTimes(1));
    let stopped = false;
    void stop.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    pending.resolve();
    await Promise.all([creation, stop]);
    expect(stopClient).toHaveBeenCalledTimes(2);
  });

  it('uses a successful retry when the initial stop rejects with a pending creation operation', async () => {
    // Catches propagating the initial stop error after a creation operation requires a retry.
    const pending = createDeferred<void>();
    const stopClient = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('initial stop failed'))
      .mockResolvedValueOnce(undefined);
    const quiescence = new AcpRuntimeQuiescence({ stopClient });
    const creation = quiescence.runClientCreationOperation(
      'session-1',
      'active',
      () => pending.promise
    );

    const stop = quiescence.stopAndQuiesce('session-1');
    await vi.waitFor(() => expect(stopClient).toHaveBeenCalledTimes(1));
    pending.resolve();

    await expect(stop).resolves.toBeUndefined();
    await creation;
    expect(stopClient).toHaveBeenCalledTimes(2);
  });

  it('propagates an initial stop error when no creation operation was tracked', async () => {
    // Catches swallowing a stop error when there is no barrier that warrants a retry.
    const stopClient = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('stop failed'));
    const quiescence = new AcpRuntimeQuiescence({ stopClient });

    await expect(quiescence.stopAndQuiesce('session-1')).rejects.toThrow('stop failed');
    expect(stopClient).toHaveBeenCalledTimes(1);
  });

  it('propagates an undefined initial stop rejection when no creation operation was tracked', async () => {
    // Catches treating an undefined rejection reason as a successful first stop.
    const stopClient = vi.fn<() => Promise<void>>().mockRejectedValue(undefined);
    const quiescence = new AcpRuntimeQuiescence({ stopClient });

    await expect(quiescence.stopAndQuiesce('session-1')).rejects.toBeUndefined();
    expect(stopClient).toHaveBeenCalledTimes(1);
  });

  it('shares overlapping same-session quiescence calls', async () => {
    // Catches duplicate stop sequences when callers concurrently quiesce one session.
    const pending = createDeferred<void>();
    const stopClient = vi.fn().mockResolvedValue(undefined);
    const quiescence = new AcpRuntimeQuiescence({ stopClient });
    const creation = quiescence.runClientCreationOperation(
      'session-1',
      'active',
      () => pending.promise
    );

    const firstStop = quiescence.stopAndQuiesce('session-1');
    const secondStop = quiescence.stopAndQuiesce('session-1');
    expect(secondStop).toBe(firstStop);
    await vi.waitFor(() => expect(stopClient).toHaveBeenCalledTimes(1));
    pending.resolve();

    await Promise.all([creation, firstStop, secondStop]);
    expect(stopClient).toHaveBeenCalledTimes(2);
  });

  it('rejects same-session creation after quiescence begins without blocking another session', async () => {
    // Catches a quiescence fence that either admits its stopped session or blocks unrelated sessions.
    const firstStop = createDeferred<void>();
    const quiescence = new AcpRuntimeQuiescence({ stopClient: vi.fn(() => firstStop.promise) });

    const stopping = quiescence.stopAndQuiesce('session-1');

    await expect(
      quiescence.runClientCreationOperation('session-1', 'active', async () => undefined)
    ).rejects.toThrow('ACP session stop requested; cannot create client session-1');
    await expect(
      quiescence.runClientCreationOperation('session-2', 'active', async () => 'created')
    ).resolves.toBe('created');

    firstStop.resolve();
    await stopping;
  });
});
