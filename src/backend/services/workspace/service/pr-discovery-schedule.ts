const BASE_DELAY_MS = 3 * 60 * 1000;
const MAX_DELAY_MS = 6 * 60 * 60 * 1000;
const MIN_JITTER_FACTOR = 0.8;
const JITTER_RANGE = 0.4;

export function computePRDiscoveryNextCheckAt(
  checkedAt: Date,
  retryCount: number,
  random: () => number = Math.random
): Date {
  const exponent = Math.max(0, retryCount - 1);
  const baseDelay = Math.min(BASE_DELAY_MS * 2 ** exponent, MAX_DELAY_MS);
  const jitteredDelay = baseDelay * (MIN_JITTER_FACTOR + random() * JITTER_RANGE);
  return new Date(checkedAt.getTime() + Math.min(jitteredDelay, MAX_DELAY_MS));
}
