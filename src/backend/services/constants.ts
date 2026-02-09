/**
 * Shared constants for backend services.
 */
export const SERVICE_LIMITS = Object.freeze({
  sessionStoreMaxQueueSize: 100,
  startupScriptOutputMaxBytes: 1024 * 1024,
  startupScriptOutputTailBytes: 512 * 1024,
} as const);

export const SERVICE_TIMEOUT_MS = Object.freeze({
  claudeCliVersionCheck: 5000,
  configDefaultClaudeHung: 60 * 60 * 1000,
  startupScriptForceKillGrace: 5000,
  portLsof: 2000,
} as const);

export const SERVICE_INTERVAL_MS = Object.freeze({
  fileLockCleanup: 5 * 60 * 1000,
  ratchetPoll: 60_000,
  ciMonitorPoll: 1 * 60 * 1000,
  ciMonitorMinNotification: 10 * 60 * 1000,
  prReviewMonitorPoll: 2 * 60 * 1000,
  schedulerPrSync: 2 * 60 * 1000,
  reconciliationCleanup: 5 * 60 * 1000,
} as const);

export const SERVICE_CACHE_TTL_MS = Object.freeze({
  ratchetAuthenticatedUsername: 5 * 60_000,
  cliHealth: 30_000,
} as const);

export const SERVICE_CONCURRENCY = Object.freeze({
  ratchetWorkspaceChecks: 5,
  ciMonitorWorkspaceChecks: 5,
  prReviewMonitorWorkspaceChecks: 5,
  schedulerPrSyncs: 5,
} as const);

export const SERVICE_THRESHOLDS = Object.freeze({
  schedulerStaleMinutes: 2,
} as const);

export const SERVICE_TTL_SECONDS = Object.freeze({
  fileLockDefault: 30 * 60,
} as const);
