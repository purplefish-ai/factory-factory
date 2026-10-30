export type TrailingRefresh = {
  /** Requests a refresh; coalesced with any refresh already in flight. */
  trigger: () => void;
  /** Stops future refreshes, including a follow-up already queued. */
  dispose: () => void;
};

/**
 * Coalesces bursts of change notifications into sequential refreshes.
 *
 * At most one refresh runs at a time. A trigger that arrives while one is in
 * flight queues exactly one follow-up, which starts after the in-flight refresh
 * settles, so the last change is always reflected without overlapping or
 * restarting requests for every notification. Dispose it when the subscriber
 * goes away so a queued follow-up does not refresh a query it no longer owns.
 */
export function createTrailingRefresh(refresh: () => unknown): TrailingRefresh {
  let running = false;
  let pending = false;
  let disposed = false;

  const trigger = (): void => {
    if (disposed) {
      return;
    }
    if (running) {
      pending = true;
      return;
    }
    running = true;
    let result: unknown;
    try {
      result = refresh();
    } catch (error) {
      result = Promise.reject(error);
    }
    void Promise.resolve(result)
      .catch(() => {
        // The query surfaces its own error state; the next trigger retries.
      })
      .finally(() => {
        running = false;
        if (pending) {
          pending = false;
          trigger();
        }
      });
  };

  const dispose = (): void => {
    disposed = true;
    pending = false;
  };

  return { trigger, dispose };
}
