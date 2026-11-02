import { createLogger } from '@/backend/services/logger.service';
import type { DispatchOptions } from './session-dispatch.types';

const logger = createLogger('session-dispatch-retry');

/** Per-attempt retries for provider busy responses and durable mail wake claims. */
export class SessionDispatchRetry {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, number>();

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
    if (this.timers.has(sessionId)) {
      return;
    }
    const attempts = this.attempts.get(sessionId) ?? 0;
    const delayMs = Math.max(minimumDelayMs, Math.min(1000 * 2 ** attempts, 30_000));
    this.attempts.set(sessionId, attempts + 1);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      void this.dispatch(sessionId, options).catch((error) => {
        logger.debug('Deferred queue retry rejected by current authority', { sessionId, error });
      });
    }, delayMs);
    this.timers.set(sessionId, timer);
  }

  clear(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
    }
    this.timers.delete(sessionId);
    this.attempts.delete(sessionId);
  }
}
