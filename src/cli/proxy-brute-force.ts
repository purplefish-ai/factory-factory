const LOCKOUT_THRESHOLD_PER_IP = 5;
export const LOCKOUT_WINDOW_MS = 5 * 60 * 1000;
const MAX_BRUTE_FORCE_TRACKED_IPS = 5000;

/**
 * Wrong passwords accepted across all clients per `LOCKOUT_WINDOW_MS`. Client
 * addresses behind a tunnel come from headers the client controls, so the
 * per-IP limit alone does not bound guessing. With 36^6 (about 2.2 billion)
 * possible passwords this allows at most 5,760 guesses a day, a chance of
 * about 1 in 378,000 per day of finding the password.
 */
export const GLOBAL_PASSWORD_FAILURE_LIMIT = 20;

export class BruteForceGuard {
  private readonly attemptsByIp = new Map<
    string,
    { failures: number; lockedUntilMs: number; lastSeenMs: number }
  >();

  private evictStaleEntries(nowMs: number): void {
    for (const [ip, state] of this.attemptsByIp.entries()) {
      const lockExpired = state.lockedUntilMs <= nowMs;
      const stale = nowMs - state.lastSeenMs > LOCKOUT_WINDOW_MS;
      if (lockExpired && stale) {
        this.attemptsByIp.delete(ip);
      }
    }

    while (this.attemptsByIp.size > MAX_BRUTE_FORCE_TRACKED_IPS) {
      const oldest = this.attemptsByIp.keys().next().value;
      if (!oldest) {
        break;
      }
      this.attemptsByIp.delete(oldest);
    }
  }

  isLocked(ip: string, nowMs = Date.now()): { locked: boolean; retryAfterSeconds: number } {
    this.evictStaleEntries(nowMs);
    const state = this.attemptsByIp.get(ip);
    if (!state || state.lockedUntilMs <= 0) {
      return { locked: false, retryAfterSeconds: 0 };
    }

    if (state.lockedUntilMs <= nowMs) {
      this.attemptsByIp.delete(ip);
      return { locked: false, retryAfterSeconds: 0 };
    }

    return {
      locked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((state.lockedUntilMs - nowMs) / 1000)),
    };
  }

  registerFailure(ip: string, nowMs = Date.now()): { ipLocked: boolean } {
    this.evictStaleEntries(nowMs);
    const current = this.attemptsByIp.get(ip) ?? { failures: 0, lockedUntilMs: 0, lastSeenMs: 0 };
    // A failure during an active lockout keeps it. Locked entries store 0 failures,
    // so an expired lockout starts a fresh count.
    const activeLockUntilMs = current.lockedUntilMs > nowMs ? current.lockedUntilMs : 0;
    const nextFailures = current.failures + 1;
    const ipLocked = activeLockUntilMs > 0 || nextFailures >= LOCKOUT_THRESHOLD_PER_IP;

    // Reinsert to keep map order roughly LRU for bounded eviction.
    this.attemptsByIp.delete(ip);
    this.attemptsByIp.set(ip, {
      failures: ipLocked ? 0 : nextFailures,
      lockedUntilMs: activeLockUntilMs || (ipLocked ? nowMs + LOCKOUT_WINDOW_MS : 0),
      lastSeenMs: nowMs,
    });

    return { ipLocked };
  }
}

/**
 * Sliding-window limit on wrong passwords from every client together. While
 * `limit` failures fall inside the window, no password is checked at all, so
 * at most `limit` wrong guesses are evaluated in any window. Signed-in
 * sessions and the direct link (a 128-bit token) are not affected.
 */
export class GlobalPasswordLockout {
  private readonly failureTimesMs: number[] = [];

  constructor(
    private readonly limit = GLOBAL_PASSWORD_FAILURE_LIMIT,
    private readonly windowMs = LOCKOUT_WINDOW_MS
  ) {}

  private prune(nowMs: number): void {
    while (
      this.failureTimesMs.length > 0 &&
      nowMs - (this.failureTimesMs[0] ?? nowMs) >= this.windowMs
    ) {
      this.failureTimesMs.shift();
    }
  }

  /** Seconds until a password may be checked again; 0 when not locked. */
  retryAfterSeconds(nowMs = Date.now()): number {
    this.prune(nowMs);
    const oldest = this.failureTimesMs[0];
    if (this.failureTimesMs.length < this.limit || oldest === undefined) {
      return 0;
    }
    return Math.max(1, Math.ceil((oldest + this.windowMs - nowMs) / 1000));
  }

  registerFailure(nowMs = Date.now()): void {
    this.prune(nowMs);
    this.failureTimesMs.push(nowMs);
  }
}
