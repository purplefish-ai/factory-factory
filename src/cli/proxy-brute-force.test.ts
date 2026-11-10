import { describe, expect, it } from 'vitest';
import { GlobalPasswordLockout } from './proxy-brute-force';

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
    let evaluated = 0;
    for (let nowMs = 0; nowMs < 10_000; nowMs += 10) {
      if (lockout.retryAfterSeconds(nowMs) === 0) {
        evaluated += 1;
        lockout.registerFailure(nowMs);
      }
    }
    expect(evaluated).toBe(50);
  });
});
