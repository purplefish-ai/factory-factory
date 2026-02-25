/**
 * Maps workspace snapshot entries (from /snapshots WebSocket) to the
 * ServerWorkspace shape consumed by the sidebar's React Query cache.
 *
 * The WorkspaceSnapshotEntry type is defined locally to avoid importing
 * from @/backend (separate build boundary). It mirrors the server type
 * but only includes fields needed for mapping.
 */

import { z } from 'zod';
import type { ServerWorkspace } from '@/client/components/use-workspace-list-state';
import {
  CIStatus,
  KanbanColumn,
  PRState,
  RatchetState,
  RunScriptStatus,
  SessionStatus,
} from '@/shared/core';

// =============================================================================
// Snapshot message types (client-side mirror of server messages)
// =============================================================================

/**
 * A workspace snapshot entry as sent by the /snapshots WebSocket endpoint.
 * Mirrors WorkspaceSnapshotEntry from the backend store but defined locally
 * to respect the frontend/backend build boundary.
 */
const SessionRuntimeLastExitSchema = z.object({
  code: z.number().nullable(),
  timestamp: z.string(),
  unexpected: z.boolean(),
});

const WorkspaceSessionSummarySchema = z.object({
  sessionId: z.string(),
  name: z.string().nullable(),
  workflow: z.string().nullable(),
  model: z.string().nullable(),
  provider: z.enum(['CLAUDE', 'CODEX']).optional(),
  persistedStatus: z.nativeEnum(SessionStatus),
  runtimePhase: z.enum(['loading', 'starting', 'running', 'idle', 'stopping', 'error']),
  processState: z.enum(['unknown', 'alive', 'stopped']),
  activity: z.enum(['WORKING', 'IDLE']),
  updatedAt: z.string(),
  lastExit: SessionRuntimeLastExitSchema.nullable(),
  errorMessage: z.string().nullable().optional(),
});
export type WorkspaceSessionSummary = z.infer<typeof WorkspaceSessionSummarySchema>;

const WorkspaceGitStatsSchema = z.object({
  total: z.number(),
  additions: z.number(),
  deletions: z.number(),
  hasUncommitted: z.boolean(),
});

const WorkspaceSidebarStatusSchema = z.object({
  activityState: z.enum(['WORKING', 'IDLE']),
  ciState: z.enum(['NONE', 'RUNNING', 'FAILING', 'PASSING', 'UNKNOWN', 'MERGED']),
});

export const WorkspaceSnapshotEntrySchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  version: z.number(),
  // Snapshot-store computation timestamp (not DB workspace.stateComputedAt).
  computedAt: z.string(),
  source: z.string(),
  name: z.string(),
  status: z.string(),
  createdAt: z.string(),
  branchName: z.string().nullable(),
  prUrl: z.string().nullable(),
  prNumber: z.number().nullable(),
  prState: z.nativeEnum(PRState),
  prCiStatus: z.nativeEnum(CIStatus),
  prUpdatedAt: z.string().nullable(),
  ratchetEnabled: z.boolean(),
  ratchetState: z.nativeEnum(RatchetState),
  runScriptStatus: z.nativeEnum(RunScriptStatus),
  hasHadSessions: z.boolean(),
  isWorking: z.boolean(),
  pendingRequestType: z.enum(['plan_approval', 'user_question', 'permission_request']).nullable(),
  sessionSummaries: z.array(WorkspaceSessionSummarySchema),
  gitStats: WorkspaceGitStatsSchema.nullable(),
  lastActivityAt: z.string().nullable(),
  sidebarStatus: WorkspaceSidebarStatusSchema,
  kanbanColumn: z.nativeEnum(KanbanColumn).nullable(),
  flowPhase: z
    .enum(['NO_PR', 'CI_WAIT', 'RATCHET_VERIFY', 'RATCHET_FIXING', 'READY', 'MERGED'])
    .nullable(),
  ciObservation: z
    .enum([
      'NOT_FETCHED',
      'NO_CHECKS',
      'CHECKS_PENDING',
      'CHECKS_FAILED',
      'CHECKS_PASSED',
      'CHECKS_UNKNOWN',
    ])
    .nullable(),
  ratchetButtonAnimated: z.boolean(),
  fieldTimestamps: z.record(z.string(), z.number()),
});

export type WorkspaceSnapshotEntry = z.infer<typeof WorkspaceSnapshotEntrySchema>;

// =============================================================================
// Server message discriminated union
// =============================================================================

const SnapshotFullMessageSchema = z.object({
  type: z.literal('snapshot_full'),
  projectId: z.string(),
  entries: z.array(WorkspaceSnapshotEntrySchema),
});

const SnapshotChangedMessageSchema = z.object({
  type: z.literal('snapshot_changed'),
  workspaceId: z.string(),
  entry: WorkspaceSnapshotEntrySchema,
});

const SnapshotRemovedMessageSchema = z.object({
  type: z.literal('snapshot_removed'),
  workspaceId: z.string(),
});

export const SnapshotServerMessageSchema = z.discriminatedUnion('type', [
  SnapshotFullMessageSchema,
  SnapshotChangedMessageSchema,
  SnapshotRemovedMessageSchema,
]);

export type SnapshotFullMessage = z.infer<typeof SnapshotFullMessageSchema>;
export type SnapshotChangedMessage = z.infer<typeof SnapshotChangedMessageSchema>;
export type SnapshotRemovedMessage = z.infer<typeof SnapshotRemovedMessageSchema>;
export type SnapshotServerMessage = z.infer<typeof SnapshotServerMessageSchema>;

// =============================================================================
// Mapping function
// =============================================================================

/**
 * Maps a WorkspaceSnapshotEntry to the ServerWorkspace shape used by the
 * sidebar's React Query cache. Renames fields and drops store-internal
 * fields (version, projectId, status, prUpdatedAt, hasHadSessions, source,
 * fieldTimestamps).
 *
 * `stateComputedAt` semantics: this value tracks the DB-backed kanban-state
 * recompute timestamp, so snapshot updates must preserve the existing cache
 * value. Snapshot transport recency is exposed separately as
 * `snapshotComputedAt`.
 */
export function mapSnapshotEntryToServerWorkspace(
  entry: WorkspaceSnapshotEntry,
  existing?: Partial<
    Pick<
      ServerWorkspace,
      | 'githubIssueNumber'
      | 'githubIssueUrl'
      | 'linearIssueId'
      | 'linearIssueIdentifier'
      | 'linearIssueUrl'
      | 'stateComputedAt'
      | 'snapshotComputedAt'
    >
  >
): ServerWorkspace {
  return {
    id: entry.workspaceId,
    name: entry.name,
    createdAt: new Date(entry.createdAt),
    branchName: entry.branchName,
    prUrl: entry.prUrl,
    prNumber: entry.prNumber,
    prState: entry.prState,
    prCiStatus: entry.prCiStatus,
    isWorking: entry.isWorking,
    sessionSummaries: entry.sessionSummaries,
    gitStats: entry.gitStats,
    lastActivityAt: entry.lastActivityAt,
    ratchetEnabled: entry.ratchetEnabled,
    ratchetState: entry.ratchetState,
    sidebarStatus: entry.sidebarStatus,
    ratchetButtonAnimated: entry.ratchetButtonAnimated,
    flowPhase: entry.flowPhase,
    ciObservation: entry.ciObservation,
    runScriptStatus: entry.runScriptStatus,
    pendingRequestType: entry.pendingRequestType,
    cachedKanbanColumn: entry.kanbanColumn,
    stateComputedAt: existing?.stateComputedAt ?? null,
    snapshotComputedAt: entry.computedAt,
    // Preserved from cache (not in snapshot data)
    githubIssueNumber: (existing?.githubIssueNumber as number | null) ?? null,
    githubIssueUrl: (existing?.githubIssueUrl as string | null) ?? null,
    linearIssueId: (existing?.linearIssueId as string | null) ?? null,
    linearIssueIdentifier: (existing?.linearIssueIdentifier as string | null) ?? null,
    linearIssueUrl: (existing?.linearIssueUrl as string | null) ?? null,
  };
}
