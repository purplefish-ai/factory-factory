/**
 * Coalesces bursts of change notifications into sequential refreshes.
 *
 * At most one refresh runs at a time. A trigger that arrives while one is in
 * flight queues exactly one follow-up, which starts after the in-flight refresh
 * settles, so the last change is always reflected without overlapping or
 * restarting requests for every notification.
 */
export function createTrailingRefresh(refresh: () => unknown): () => void {
  let running = false;
  let pending = false;

  const trigger = (): void => {
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

  return trigger;
}
