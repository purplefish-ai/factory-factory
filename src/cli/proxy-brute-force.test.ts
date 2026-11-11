import { describe, expect, it } from 'vitest';
import { BruteForceGuard, GlobalPasswordLockout, LOCKOUT_WINDOW_MS } from './proxy-brute-force';

function lockOut(guard: BruteForceGuard, ip: string, nowMs: number): void {
  for (let i = 0; i < 5; i += 1) {
    guard.registerFailure(ip, nowMs);
  }
}

describe('BruteForceGuard', () => {
  it('keeps an active lockout when other clients fill the tracker', () => {
    const guard = new BruteForceGuard(3);
    lockOut(guard, 'locked', 0);

    for (let i = 0; i < 10; i += 1) {
      guard.registerFailure(`other-${i}`, 1);
    }

    expect(guard.isLocked('locked', 2).locked).toBe(true);
  });

  it('evicts the least recently seen unlocked client to track a new one', () => {
    const guard = new BruteForceGuard(2);
    for (let i = 0; i < 4; i += 1) {
      guard.registerFailure('first', 0);
      guard.registerFailure('second', 0);
    }

    // `first` is evicted, so its four failures are forgotten; `second` keeps its count.
    guard.registerFailure('third', 1);
    expect(guard.registerFailure('second', 2).ipLocked).toBe(true);
    expect(guard.registerFailure('first', 3).ipLocked).toBe(false);
  });

  it('stops tracking new clients rather than dropping a lockout when every entry is locked', () => {
    const guard = new BruteForceGuard(2);
    lockOut(guard, 'a', 0);
    lockOut(guard, 'b', 0);

    for (let i = 0; i < 6; i += 1) {
      expect(guard.registerFailure('c', 1).ipLocked).toBe(false);
    }
    expect(guard.isLocked('a', 2).locked).toBe(true);
    expect(guard.isLocked('b', 2).locked).toBe(true);

    // Once the lockouts expire there is room again and `c` is tracked.
    const laterMs = LOCKOUT_WINDOW_MS + 1;
    for (let i = 0; i < 4; i += 1) {
      expect(guard.registerFailure('c', laterMs).ipLocked).toBe(false);
    }
    expect(guard.registerFailure('c', laterMs).ipLocked).toBe(true);
  });
});

describe('GlobalPasswordLockout', () => {
  it('locks once the limit of failures falls inside the window', () => {
    const lockout = new GlobalPasswordLockout(3, 60_000);
    lockout.registerFailure(0);
    lockout.registerFailure(10_000);
    expect(lockout.retryAfterSeconds(10_000)).toBe(0);

    lockout.registerFailure(20_000);
    // The oldest failure leaves the window at 60s.
    expect(lockout.retryAfterSeconds(20_000)).toBe(40);
    expect(lockout.retryAfterSeconds(59_999)).toBe(1);
    expect(lockout.retryAfterSeconds(60_000)).toBe(0);
  });

  it('never admits more than the limit of failures in any window', () => {
    const lockout = new GlobalPasswordLockout(5, 1000);
    const admittedMs: number[] = [];
    for (let nowMs = 0; nowMs < 10_000; nowMs += 10) {
      if (lockout.retryAfterSeconds(nowMs) === 0) {
        admittedMs.push(nowMs);
        lockout.registerFailure(nowMs);
      }
    }
    // Every window starting at an admitted failure holds at most five.
    for (const startMs of admittedMs) {
      const inWindow = admittedMs.filter((t) => t >= startMs && t < startMs + 1000);
      expect(inWindow.length).toBeLessThanOrEqual(5);
    }
    // And the limit is reached rather than undercut.
    expect(admittedMs).toHaveLength(50);
  });
});
