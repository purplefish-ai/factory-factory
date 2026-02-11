/**
 * Maps workspace snapshot entries (from /snapshots WebSocket) to the
 * ServerWorkspace shape consumed by the sidebar's React Query cache.
 *
 * The WorkspaceSnapshotEntry type is defined locally to avoid importing
 * from @/backend (separate build boundary). It mirrors the server type
 * but only includes fields needed for mapping.
 */

import type { CIStatus, PRState, RatchetState, RunScriptStatus } from '@prisma-gen/browser';
import type { ServerWorkspace } from '@/frontend/components/use-workspace-list-state';
import type { SessionSummary } from '@/shared/session-runtime';
import type { WorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';

// =============================================================================
// Snapshot message types (client-side mirror of server messages)
// =============================================================================

export type WorkspaceSessionSummary = SessionSummary;

/**
 * A workspace snapshot entry as sent by the /snapshots WebSocket endpoint.
 * Mirrors WorkspaceSnapshotEntry from the backend store but defined locally
 * to respect the frontend/backend build boundary.
 */
export interface WorkspaceSnapshotEntry {
  workspaceId: string;
  projectId: string;
  version: number;
  computedAt: string;
  source: string;
  name: string;
  status: string;
  createdAt: string;
  branchName: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prState: PRState;
  prCiStatus: CIStatus;
  prUpdatedAt: string | null;
  ratchetEnabled: boolean;
  ratchetState: RatchetState;
  runScriptStatus: RunScriptStatus;
  hasHadSessions: boolean;
  isWorking: boolean;
  pendingRequestType: 'plan_approval' | 'user_question' | null;
  sessionSummaries: WorkspaceSessionSummary[];
  gitStats: {
    total: number;
    additions: number;
    deletions: number;
    hasUncommitted: boolean;
  } | null;
  lastActivityAt: string | null;
  sidebarStatus: WorkspaceSidebarStatus;
  kanbanColumn: string | null;
  flowPhase: string | null;
  ciObservation: string | null;
  ratchetButtonAnimated: boolean;
  fieldTimestamps: Record<string, number>;
}

// =============================================================================
// Server message discriminated union
// =============================================================================

export interface SnapshotFullMessage {
  type: 'snapshot_full';
  projectId: string;
  entries: WorkspaceSnapshotEntry[];
}

export interface SnapshotChangedMessage {
  type: 'snapshot_changed';
  workspaceId: string;
  entry: WorkspaceSnapshotEntry;
}

export interface SnapshotRemovedMessage {
  type: 'snapshot_removed';
  workspaceId: string;
}

export type SnapshotServerMessage =
  | SnapshotFullMessage
  | SnapshotChangedMessage
  | SnapshotRemovedMessage;

// =============================================================================
// Mapping function
// =============================================================================

/**
 * Maps a WorkspaceSnapshotEntry to the ServerWorkspace shape used by the
 * sidebar's React Query cache. Renames fields and drops store-internal
 * fields (version, projectId, status, prUpdatedAt, hasHadSessions, source,
 * fieldTimestamps).
 */
export function mapSnapshotEntryToServerWorkspace(entry: WorkspaceSnapshotEntry): ServerWorkspace {
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
    stateComputedAt: entry.computedAt,
  };
}
