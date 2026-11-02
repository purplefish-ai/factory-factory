import { afterEach, expect, it, vi } from 'vitest';
import { getPermanentBlockedDispatchReason } from './session-dispatch-gate';
import { SessionDispatchRetry } from './session-dispatch-retry';

afterEach(() => vi.useRealTimers());

it('extends an existing busy retry to the mail lease minimum while preserving original authority', async () => {
  vi.useFakeTimers();
  const dispatch = vi.fn(async () => undefined);
  const retry = new SessionDispatchRetry(dispatch);
  const original = { guard: { check: vi.fn(async () => undefined) } };
  const replacement = { guard: { check: vi.fn(async () => undefined) } };
  retry.schedule('session', original);
  await vi.advanceTimersByTimeAsync(500);
  retry.schedule('session', replacement, 30_000);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(dispatch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith('session', original);
});

it('does not shorten a pending retry when another caller requests a smaller minimum', async () => {
  vi.useFakeTimers();
  const dispatch = vi.fn(async () => undefined);
  const retry = new SessionDispatchRetry(dispatch);
  retry.schedule('session', undefined, 30_000);
  retry.schedule('session', undefined, 1000);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(dispatch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(dispatch).toHaveBeenCalledOnce();
});

it('permanently rejects failed setup with a whitespace-only worktree path', () => {
  expect(getPermanentBlockedDispatchReason({ status: 'FAILED', worktreePath: ' \t ' })).toContain(
    'setup failed'
  );
});
