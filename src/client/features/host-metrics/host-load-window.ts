import type { HostLoadSample } from './host-load';

/** One `admin.getHostMetrics` answer: what is new since a cursor, or the whole window. */
export interface HostLoadHistory {
  samples: readonly HostLoadSample[];
  /** The cursor the samples continue from; `null` when they are the whole window. */
  since: number | null;
  /** When the oldest sample the server still holds was taken. */
  oldestAt: number;
}

/**
 * Folds one poll into the window the client holds, so it holds what the server
 * holds. A whole window replaces it: after a server restart or a reset nothing
 * from before joins the new line. New samples are added, one per time and
 * oldest first, and samples the server has dropped are dropped here too.
 */
export function mergeHostLoadHistory(
  held: readonly HostLoadSample[] | undefined,
  history: HostLoadHistory
): HostLoadSample[] {
  const base = history.since === null ? [] : (held ?? []);
  const byTime = new Map<number, HostLoadSample>();
  for (const sample of [...base, ...history.samples]) {
    if (sample.at >= history.oldestAt) {
      byTime.set(sample.at, sample);
    }
  }
  return [...byTime.values()].sort((a, b) => a.at - b.at);
}

/** The next poll's input: everything after the newest sample held, or the whole window. */
export function hostLoadCursor(
  held: readonly HostLoadSample[] | undefined
): { after: number } | undefined {
  const newest = held?.at(-1);
  return newest ? { after: newest.at } : undefined;
}
