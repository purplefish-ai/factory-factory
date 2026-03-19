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
  claudeCliAuthCheck: 5000,
  codexCliVersionCheck: 5000,
  codexCliAuthCheck: 5000,
  cliLatestVersionCheck: 3000,
  cliUpgrade: 120_000,
  startupScriptForceKillGrace: 5000,
  portLsof: 2000,
  ratchetWorkspaceCheck: 90_000,
} as const);

export const SERVICE_INTERVAL_MS = Object.freeze({
  fileLockCleanup: 5 * 60 * 1000,
  ratchetPoll: 3 * 60_000,
  schedulerPrSync: 3 * 60 * 1000,
  schedulerAutoArchive: 5 * 60 * 1000,
  reconciliationCleanup: 5 * 60 * 1000,
  dbBackup: 5 * 60 * 1000,
} as const);

export const SERVICE_CACHE_TTL_MS = Object.freeze({
  ratchetAuthenticatedUsername: 5 * 60_000,
  cliHealth: 30_000,
  githubHealth: 30_000,
  githubUsername: 5 * 60_000,
  githubIssues: 30_000,
  githubReviewRequests: 30_000,
} as const);

export const SERVICE_CONCURRENCY = Object.freeze({
  ratchetWorkspaceChecks: 20,
  schedulerPrSyncs: 20,
} as const);

export const SERVICE_THRESHOLDS = Object.freeze({
  schedulerStaleMinutes: 2,
  ratchetReviewCheckStaleMs: 10 * 60_000, // 10min: treat prReviewLastCheckedAt as stale if no active session
} as const);

export const SERVICE_TTL_SECONDS = Object.freeze({
  fileLockDefault: 30 * 60,
} as const);
