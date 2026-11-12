/**
 * Shared constants for backend services.
 */
export const SERVICE_LIMITS = Object.freeze({
  sessionStoreMaxQueueSize: 100,
  startupScriptOutputMaxBytes: 1024 * 1024,
  startupScriptOutputTailBytes: 512 * 1024,
  workspaceScopedCacheMaxEntries: 1024,
} as const);

export const SERVICE_TIMEOUT_MS = Object.freeze({
  agentLaunchLease: 60_000,
  // Enable prepares GitHub baselines in the request; an interrupted one retries after the next poll.
  agentActivationBaseline: 60_000,
  eventWorkspaceSetup: 15 * 60 * 1000,
  claudeCliVersionCheck: 5000,
  claudeCliAuthCheck: 5000,
  codexCliVersionCheck: 5000,
  codexCliAuthCheck: 5000,
  startupScriptForceKillGrace: 5000,
  startupScriptOutputDrain: 1000,
  portLsof: 2000,
  ratchetWorkspaceCheck: 90_000,
} as const);

export const SERVICE_INTERVAL_MS = Object.freeze({
  applicationUpdateIdle: 1000,
  agentSourcePoll: 60_000,
  agentEventEvaluation: 5000,
  agentSlackIntake: 15_000,
  workspaceMetadata: 10_000,
  prEventPoll: 2 * 60_000, // Increased from 1min to 2min to reduce GitHub API pressure
  prPoll: 3 * 60 * 1000, // Increased from 2min to 3min to reduce GitHub API pressure
  reconciliationCleanup: 5 * 60 * 1000,
  periodicTaskPoll: 60_000, // Check for due periodic tasks every 60 seconds
  snapshotReconciliation: 60_000, // Safety-net recompute of workspace snapshots
  prEventRetention: 30 * 60_000, // Bounded deletion of old terminal PR facts
  archivedWorkspaceBlobRetention: 10 * 60_000, // Bounded release of archived attachments/logs
} as const);

export const SERVICE_CACHE_TTL_MS = Object.freeze({
  ratchetAuthenticatedUsername: 5 * 60_000,
  cliHealth: 30_000,
  workspacePrFetchInFlight: 10 * 60_000,
  workspaceSnapshotRemovalGrace: 10 * 60_000,
} as const);

export const SERVICE_THRESHOLDS = Object.freeze({
  schedulerStaleMinutes: 2,
} as const);
