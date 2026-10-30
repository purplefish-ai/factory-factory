/**
 * Runs at most one task per key at a time and collapses bursts into one rerun.
 *
 * The first request for an idle key starts immediately, so a lone event pays
 * no extra latency. Requests that arrive while that key's task is running mark
 * one trailing rerun, which uses the most recent task, so the final state is
 * always read after the last request without running one task per request.
 */
export class KeyedTrailingRunner {
  private readonly runs = new Map<string, { task: () => Promise<void>; rerun: boolean }>();

  run(key: string, task: () => Promise<void>): void {
    const current = this.runs.get(key);
    if (current) {
      current.task = task;
      current.rerun = true;
      return;
    }
    const entry = { task, rerun: false };
    this.runs.set(key, entry);
    void this.drain(key, entry);
  }

  /** Drops queued reruns; tasks already running finish on their own. */
  clear(): void {
    for (const entry of this.runs.values()) {
      entry.rerun = false;
    }
    this.runs.clear();
  }

  private async drain(
    key: string,
    entry: { task: () => Promise<void>; rerun: boolean }
  ): Promise<void> {
    try {
      do {
        entry.rerun = false;
        try {
          await entry.task();
        } catch {
          // Tasks report their own failures; a failed run must not block the key.
        }
      } while (entry.rerun && this.runs.get(key) === entry);
    } finally {
      if (this.runs.get(key) === entry) {
        this.runs.delete(key);
      }
    }
  }
}
