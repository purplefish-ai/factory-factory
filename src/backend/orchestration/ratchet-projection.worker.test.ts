import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { workspaceDataService } from '@/backend/services/workspace';
import { RatchetProjectionWorker } from './ratchet-projection.worker';

type Projection = Awaited<ReturnType<typeof workspaceDataService.findRatchetProjection>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

const readyProjection = {
  status: 'READY',
  ratchetEnabled: true,
  ratchetState: 'CI_FAILED',
  ratchetDispatchOutcome: 'DIED',
  ratchetDispatchRetryCount: 3,
  ratchetDispatchStalled: true,
  prHasMergeConflict: false,
} satisfies Projection;

describe('RatchetProjectionWorker', () => {
  const read = vi.fn<typeof workspaceDataService.findRatchetProjection>();
  const publish = vi.fn();
  let worker: RatchetProjectionWorker;

  beforeEach(() => {
    vi.useFakeTimers();
    read.mockReset().mockResolvedValue(readyProjection);
    publish.mockReset();
    worker = new RatchetProjectionWorker({ read, publish, logger: { warn: vi.fn() } });
  });

  afterEach(() => {
    worker.stop();
    vi.useRealTimers();
  });

  it('retries a failed authoritative projection without another invalidation', async () => {
    read.mockRejectedValueOnce(new Error('read failed')).mockResolvedValue({
      status: 'READY',
      ratchetEnabled: true,
      ratchetState: 'CI_FAILED',
      ratchetDispatchOutcome: 'DIED',
      ratchetDispatchRetryCount: 3,
      ratchetDispatchStalled: false,
      prHasMergeConflict: false,
    });

    worker.request('ws-retry');
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000);

    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(publish).toHaveBeenCalledWith(
      'ws-retry',
      expect.objectContaining({ ratchetDispatchOutcome: 'DIED' })
    );
  });

  it('backs off materially after a persistent authoritative projection failure', async () => {
    read.mockRejectedValue(new Error('read failed'));

    worker.request('ws-persistent-failure');
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('backs off when an invalidation arrives during a failed projection read', async () => {
    const pendingRead = deferred<Projection>();
    read.mockReturnValueOnce(pendingRead.promise).mockResolvedValue({
      status: 'READY',
      ratchetEnabled: true,
      ratchetState: 'CI_FAILED',
      ratchetDispatchOutcome: 'DIED',
      ratchetDispatchRetryCount: 3,
      ratchetDispatchStalled: false,
      prHasMergeConflict: false,
    });

    worker.request('ws-concurrent-invalidation');
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    worker.request('ws-concurrent-invalidation');
    pendingRead.reject(new Error('read failed'));
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not reset the projection failure budget for repeated invalidations', async () => {
    read.mockRejectedValue(new Error('read failed'));

    worker.request('ws-invalidation-stream');
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    worker.request('ws-invalidation-stream');
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);
    worker.request('ws-invalidation-stream');
    await vi.advanceTimersByTimeAsync(1999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('cancels an authoritative projection retry when stopped', async () => {
    read.mockRejectedValue(new Error('read failed'));

    worker.request('ws-stop-retry');
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    worker.stop();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('re-reads invalidations during a successful read and accepts a later request', async () => {
    const pendingRead = deferred<Projection>();
    read.mockReturnValueOnce(pendingRead.promise);
    worker.request('ws');
    worker.request('ws');
    worker.request('ws');
    expect(read).toHaveBeenCalledTimes(1);

    pendingRead.resolve({ ...readyProjection, ratchetState: 'CI_RUNNING' });
    await vi.advanceTimersByTimeAsync(0);

    expect(read).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith('ws', {
      ratchetEnabled: true,
      ratchetState: 'CI_FAILED',
      ratchetDispatchOutcome: 'DIED',
      ratchetDispatchRetryCount: 3,
      ratchetDispatchStalled: true,
      hasMergeConflict: false,
    });
    worker.request('ws');
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each(['ARCHIVING', 'ARCHIVED'] as const)('does not publish a %s row', async (status) => {
    read.mockResolvedValue({ ...readyProjection, status });
    worker.request('ws');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(publish).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not retry a missing workspace', async () => {
    read.mockResolvedValue(null);
    worker.request('ws');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(publish).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('suppresses retries and requests while archived and allows requests when restored', async () => {
    read.mockRejectedValueOnce(new Error('read failed'));
    worker.request('ws');
    await vi.advanceTimersByTimeAsync(0);
    worker.setArchived('ws', true);
    worker.request('ws');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();

    worker.setArchived('ws', false);
    worker.request('ws');
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledWith(
      'ws',
      expect.objectContaining({ ratchetState: 'CI_FAILED' })
    );
  });

  it("discards a stopped lifetime's in-flight read when a new worker has started", async () => {
    const pendingRead = deferred<Projection>();
    read.mockReturnValueOnce(pendingRead.promise);
    worker.request('ws');
    worker.stop();
    worker.request('ws');
    expect(read).toHaveBeenCalledTimes(1);

    worker = new RatchetProjectionWorker({ read, publish, logger: { warn: vi.fn() } });
    worker.request('ws');
    await vi.advanceTimersByTimeAsync(0);
    pendingRead.resolve({ ...readyProjection, ratchetState: 'CI_RUNNING' });
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      'ws',
      expect.objectContaining({ ratchetState: 'CI_FAILED' })
    );
  });
});
