/**
 * Maps workspace snapshot entries (from /snapshots WebSocket) to the
 * kanban workspace shape consumed by the Kanban board's React Query cache.
 *
 * Similar to snapshot-to-sidebar.ts but targets the `listWithKanbanState`
 * cache which uses a different shape (WorkspaceWithKanban extends Workspace).
 *
 * Returns Record<string, unknown> to avoid needing the full Prisma Workspace
 * type. The `as never` assertion in the setData callback handles the type
 * boundary — same pattern used for sidebar cache updates.
 */

import type { WorkspaceSnapshotEntry } from '@/client/lib/snapshot-to-sidebar';

// =============================================================================
// Mapping function
// =============================================================================

/**
 * Maps a WorkspaceSnapshotEntry to the kanban workspace shape used by the
 * `listWithKanbanState` React Query cache. Merges fields not present in
 * the snapshot from the existing cache entry (or defaults to null).
 */
export function mapSnapshotEntryToKanbanWorkspace(
  entry: WorkspaceSnapshotEntry,
  existing?: Record<string, unknown>
): Record<string, unknown> {
  return {
    // Fields from snapshot (authoritative real-time state)
    id: entry.workspaceId,
    name: entry.name,
    status: entry.status,
    createdAt: new Date(entry.createdAt),
    branchName: entry.branchName,
    prUrl: entry.prUrl,
    prNumber: entry.prNumber,
    prState: entry.prState,
    prCiStatus: entry.prCiStatus,
    ratchetEnabled: entry.ratchetEnabled,
    ratchetState: entry.ratchetState,
    runScriptStatus: entry.runScriptStatus,
    kanbanColumn: entry.kanbanColumn,
    isWorking: entry.isWorking,
    sessionSummaries: entry.sessionSummaries,
    ratchetButtonAnimated: entry.ratchetButtonAnimated,
    flowPhase: entry.flowPhase,
    pendingRequestType: entry.pendingRequestType,
    isArchived: false,

    // Fields NOT in snapshot — merge from existing cache entry or default to null
    description: existing?.description ?? null,
    initErrorMessage: existing?.initErrorMessage ?? null,
    githubIssueNumber: existing?.githubIssueNumber ?? null,
  };
}
