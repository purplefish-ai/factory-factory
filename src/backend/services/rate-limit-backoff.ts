import type { createLogger } from './logger.service';

type Logger = ReturnType<typeof createLogger>;

/**
 * Shared rate limit backoff logic for polling services.
 *
 * Tracks whether a rate limit was hit during a polling cycle and applies
 * exponential backoff (up to maxMultiplier). Only increases the multiplier
 * once per cycle regardless of how many individual requests hit the limit.
 */
export class RateLimitBackoff {
  private multiplier = 1;
  private rateLimitHitThisCycle = false;
  private readonly maxMultiplier: number;

  constructor(maxMultiplier = 4) {
    this.maxMultiplier = maxMultiplier;
  }

  /** Call at the start of each polling cycle to reset the per-cycle flag. */
  beginCycle(): void {
    this.rateLimitHitThisCycle = false;
  }

  /**
   * Call after a successful cycle (no rate limits hit) to reset the multiplier.
   * Returns true if the multiplier was actually reset.
   */
  resetIfCleanCycle(logger: Logger, serviceName: string): boolean {
    if (this.multiplier > 1 && !this.rateLimitHitThisCycle) {
      logger.info(`${serviceName} check succeeded, resetting backoff`, {
        previousMultiplier: this.multiplier,
      });
      this.multiplier = 1;
      return true;
    }
    return false;
  }

  /**
   * Handle an error from a workspace check. Classifies whether it's a rate
   * limit error and, if so, increases the backoff multiplier (at most once
   * per cycle). Returns true if the error was a rate limit.
   */
  handleError(
    error: unknown,
    logger: Logger,
    serviceName: string,
    context: { workspaceId: string; prUrl: string },
    baseIntervalMs: number
  ): boolean {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const lowerMessage = errorMessage.toLowerCase();
    const isRateLimit =
      lowerMessage.includes('429') ||
      lowerMessage.includes('rate limit') ||
      lowerMessage.includes('throttl');

    if (isRateLimit) {
      if (!this.rateLimitHitThisCycle && this.multiplier < this.maxMultiplier) {
        this.multiplier = Math.min(this.multiplier * 2, this.maxMultiplier);
      }
      this.rateLimitHitThisCycle = true;
      logger.warn(`GitHub rate limit hit in ${serviceName}, backing off`, {
        workspaceId: context.workspaceId,
        prUrl: context.prUrl,
        backoffMultiplier: this.multiplier,
        nextDelayMs: baseIntervalMs * this.multiplier,
      });
      return true;
    }

    logger.error(`${serviceName} check failed for workspace`, error as Error, {
      workspaceId: context.workspaceId,
      prUrl: context.prUrl,
    });
    return false;
  }

  /** Current delay multiplier (1 = no backoff). */
  get currentMultiplier(): number {
    return this.multiplier;
  }

  /** Compute the actual delay for the next cycle. */
  computeDelay(baseIntervalMs: number): number {
    return baseIntervalMs * this.multiplier;
  }

  /** Whether the current cycle has been affected by rate limiting. */
  get wasRateLimitedThisCycle(): boolean {
    return this.rateLimitHitThisCycle;
  }
}
