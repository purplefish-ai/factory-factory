export const GH_TIMEOUT_MS = Object.freeze({
  healthVersion: 5000,
  healthAuth: 10_000,
  userLookup: 10_000,
  default: 30_000,
  reviewDetails: 10_000,
  diff: 60_000,
} as const);

export const GH_MAX_BUFFER_BYTES = Object.freeze({
  diff: 10 * 1024 * 1024, // 10MB buffer for large diffs
} as const);
