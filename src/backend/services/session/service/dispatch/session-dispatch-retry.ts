import { createLogger } from '@/backend/services/logger.service';
import type { DispatchOptions } from './session-dispatch.types';

const logger = createLogger('session-dispatch-retry');
type PendingDispatchRetry = {
  timer: ReturnType<typeof setTimeout>;
  retryAt: number;
  options?: DispatchOptions;
};

/** A coalesced retry must satisfy every caller's original authority. */
function mergeRetryOptions(
  original?: DispatchOptions,
  incoming?: DispatchOptions
): DispatchOptions | undefined {
  if (!original) {
    return incoming;
  }
  const previousGuard = original.guard;
  const nextGuard = incoming?.guard;
  if (!nextGuard || previousGuard === nextGuard) {
    return original;
  }
  if (!previousGuard) {
    return { ...original, guard: nextGuard };
  }
  return {
    ...original,
    guard: {
      check: async () => {
        await previousGuard.check();
        await nextGuard.check();
      },
      assertCurrent: () => {
        previousGuard.assertCurrent?.();
        nextGuard.assertCurrent?.();
      },
    },
  };
}

/** Per-attempt retries for provider busy responses and durable mail wake claims. */
export class SessionDispatchRetry {
  private readonly timers = new Map<string, PendingDispatchRetry>();
  private readonly attempts = new Map<string, number>();
  private readonly running = new Set<Promise<void>>();
  private stopped = false;

  constructor(
    private readonly dispatch: (sessionId: string, options?: DispatchOptions) => Promise<void>
  ) {}

  has(sessionId: string): boolean {
    return this.timers.has(sessionId);
  }

  resetAttempts(sessionId: string): void {
    this.attempts.delete(sessionId);
  }

  schedule(sessionId: string, options?: DispatchOptions, minimumDelayMs = 0): void {
    if (this.stopped) {
      return;
    }
    const existing = this.timers.get(sessionId);
    const retainedOptions = mergeRetryOptions(existing?.options, options);
    if (existing) {
      existing.options = retainedOptions;
    }
    if (existing && existing.retryAt >= Date.now() + minimumDelayMs) {
      return;
    }
    if (existing) {
      clearTimeout(existing.timer);
    }
    const attempts = this.attempts.get(sessionId) ?? 0;
    const delayMs = Math.max(minimumDelayMs, Math.min(1000 * 2 ** attempts, 30_000));
    if (!existing) {
      this.attempts.set(sessionId, attempts + 1);
    }
    const pending: PendingDispatchRetry = {
      timer: setTimeout(() => {
        this.timers.delete(sessionId);
        const run = this.dispatch(sessionId, pending.options).catch((error) => {
          logger.debug('Deferred queue retry rejected by current authority', { sessionId, error });
        });
        this.running.add(run);
        void run.finally(() => this.running.delete(run));
      }, delayMs),
      retryAt: Date.now() + delayMs,
      options: retainedOptions,
    };
    this.timers.set(sessionId, pending);
  }

  clear(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearTimeout(timer.timer);
    }
    this.timers.delete(sessionId);
    this.attempts.delete(sessionId);
  }

  /**
   * Cancel every pending retry, refuse new ones and wait for retries already
   * dispatching. A failing retry re-arms itself, so without this a timer can
   * outlive shutdown and reach a disconnected database.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const sessionId of [...this.timers.keys()]) {
      this.clear(sessionId);
    }
    while (this.running.size > 0) {
      await Promise.all(this.running);
    }
  }
}
