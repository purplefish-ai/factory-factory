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
  ratchetPoll: 2 * 60_000, // Increased from 1min to 2min to reduce GitHub API pressure
  schedulerPrSync: 3 * 60 * 1000, // Increased from 2min to 3min to reduce GitHub API pressure
  reconciliationCleanup: 5 * 60 * 1000,
  periodicTaskPoll: 60_000, // Check for due periodic tasks every 60 seconds
} as const);

export const SERVICE_CACHE_TTL_MS = Object.freeze({
  ratchetAuthenticatedUsername: 5 * 60_000,
  cliHealth: 30_000,
  workspaceSnapshotRemovalGrace: 10 * 60_000,
} as const);

export const SERVICE_THRESHOLDS = Object.freeze({
  schedulerStaleMinutes: 2,
  ratchetDispatchMaxRetries: 3, // Max re-dispatches of a DIED fixer for an unchanged PR state
} as const);

export const SERVICE_TTL_SECONDS = Object.freeze({
  fileLockDefault: 30 * 60,
} as const);
