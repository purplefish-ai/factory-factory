/**
 * Shared constants for Claude process/protocol integration.
 */
export const CLAUDE_TIMEOUT_MS = Object.freeze({
  processSpawn: 30_000,
  protocolRequestDefault: 60_000,
} as const);

export const CLAUDE_LIMITS = Object.freeze({
  protocolMaxLineLengthBytes: 1_000_000,
} as const);
