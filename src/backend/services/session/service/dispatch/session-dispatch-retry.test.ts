import { afterEach, expect, it, vi } from 'vitest';
import { deferred } from '@/test-utils/deferred';
import { getPermanentBlockedDispatchReason } from './session-dispatch-gate';
import { SessionDispatchRetry } from './session-dispatch-retry';
import type { DispatchOptions } from './session-dispatch.types';

afterEach(() => vi.useRealTimers());

it('extends an existing busy retry to the mail lease minimum while preserving original authority', async () => {
  vi.useFakeTimers();
  const dispatch = vi
    .fn<(id: string, options?: DispatchOptions) => Promise<void>>()
    .mockResolvedValue(undefined);
  const retry = new SessionDispatchRetry(dispatch);
  const original = { guard: { check: vi.fn(async () => undefined) } };
  const replacement = { guard: { check: vi.fn(async () => undefined) } };
  retry.schedule('session', original);
  await vi.advanceTimersByTimeAsync(500);
  retry.schedule('session', replacement, 30_000);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(dispatch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(dispatch).toHaveBeenCalledOnce();
  const deliveredOptions = vi.mocked(dispatch).mock.calls[0]?.[1];
  await deliveredOptions?.guard?.check();
  expect(original.guard.check).toHaveBeenCalledOnce();
  expect(replacement.guard.check).toHaveBeenCalledOnce();
});

it.each([0, 30_000])(
  'adopts a new mail guard on an unguarded busy retry with minimum %s',
  async (minimumDelay) => {
    vi.useFakeTimers();
    const dispatch = vi
      .fn<(id: string, options?: DispatchOptions) => Promise<void>>()
      .mockResolvedValue(undefined);
    const retry = new SessionDispatchRetry(dispatch);
    const mail = { guard: { check: vi.fn(async () => undefined) } };
    retry.schedule('session');
    retry.schedule('session', mail, minimumDelay);
    await vi.advanceTimersByTimeAsync(Math.max(1000, minimumDelay));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith('session', mail);
  }
);

it('retains both asynchronous and synchronous authority when coalescing guarded retries', async () => {
  vi.useFakeTimers();
  const dispatch = vi
    .fn<(id: string, options?: DispatchOptions) => Promise<void>>()
    .mockResolvedValue(undefined);
  const retry = new SessionDispatchRetry(dispatch);
  const first = { guard: { check: vi.fn(async () => undefined), assertCurrent: vi.fn() } };
  const second = { guard: { check: vi.fn(async () => undefined), assertCurrent: vi.fn() } };
  retry.schedule('session', first, 30_000);
  retry.schedule('session', second);
  await vi.advanceTimersByTimeAsync(30_000);
  const merged = dispatch.mock.calls[0]?.[1];
  await merged?.guard?.check();
  merged?.guard?.assertCurrent?.();
  expect(first.guard.check).toHaveBeenCalledOnce();
  expect(first.guard.assertCurrent).toHaveBeenCalledOnce();
  expect(second.guard.check).toHaveBeenCalledOnce();
  expect(second.guard.assertCurrent).toHaveBeenCalledOnce();
  first.guard.check.mockRejectedValueOnce(new Error('original revoked'));
  await expect(merged?.guard?.check()).rejects.toThrow('original revoked');
  second.guard.assertCurrent.mockImplementationOnce(() => {
    throw new Error('mail revoked');
  });
  expect(() => merged?.guard?.assertCurrent?.()).toThrow('mail revoked');
});

it('adopts incoming authority when original retry options had no guard', async () => {
  vi.useFakeTimers();
  const dispatch = vi
    .fn<(id: string, options?: DispatchOptions) => Promise<void>>()
    .mockResolvedValue(undefined);
  const retry = new SessionDispatchRetry(dispatch);
  const guard = { check: vi.fn(async () => undefined) };
  retry.schedule('session', { bypassTurnInProgressBackoff: true }, 30_000);
  retry.schedule('session', { guard });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith('session', {
    bypassTurnInProgressBackoff: true,
    guard,
  });
});

it('does not shorten a pending retry when another caller requests a smaller minimum', async () => {
  vi.useFakeTimers();
  const dispatch = vi
    .fn<(id: string, options?: DispatchOptions) => Promise<void>>()
    .mockResolvedValue(undefined);
  const retry = new SessionDispatchRetry(dispatch);
  retry.schedule('session', undefined, 30_000);
  retry.schedule('session', undefined, 1000);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(dispatch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(dispatch).toHaveBeenCalledOnce();
});

it('cancels pending retries on stop and refuses ones armed afterwards', async () => {
  vi.useFakeTimers();
  const dispatch = vi
    .fn<(id: string, options?: DispatchOptions) => Promise<void>>()
    .mockResolvedValue(undefined);
  const retry = new SessionDispatchRetry(dispatch);
  retry.schedule('pending', undefined, 1000);
  await retry.stop();
  retry.schedule('late', undefined, 1000);
  expect(retry.has('pending')).toBe(false);
  expect(retry.has('late')).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(dispatch).not.toHaveBeenCalled();
});

it('waits on stop for a dispatching retry and drops the retry it re-arms', async () => {
  vi.useFakeTimers();
  const release = deferred();
  const retry = new SessionDispatchRetry(async (id) => {
    await release.promise;
    // A failed mail recovery re-arms its own retry before the dispatch settles.
    retry.schedule(id, undefined, 1000);
  });
  retry.schedule('session', undefined, 1000);
  await vi.advanceTimersByTimeAsync(1000);
  let stopped = false;
  const stopping = retry.stop().then(() => {
    stopped = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(stopped).toBe(false);
  release.resolve();
  await stopping;
  expect(retry.has('session')).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('permanently rejects failed setup with a whitespace-only worktree path', () => {
  expect(getPermanentBlockedDispatchReason({ status: 'FAILED', worktreePath: ' \t ' })).toContain(
    'setup failed'
  );
});
