/**
 * React hook that syncs /snapshots WebSocket messages into both the
 * getProjectSummaryState (sidebar), listWithKanbanState (kanban), and
 * workspace.get (detail header/session runtime) React Query cache entries.
 * Also invalidates the workspace.list cache so the table view refetches
 * with fresh data on every snapshot event.
 *
 * Follows the use-dev-logs.ts pattern: receive-only WebSocket hook with
 * drop queue policy (no outbound messages, reconnect discards stale data).
 */

import { useCallback } from 'react';
import { mapSnapshotEntryToKanbanWorkspace } from '@/frontend/lib/snapshot-to-kanban';
import {
  mapSnapshotEntryToServerWorkspace,
  SnapshotServerMessageSchema,
  type WorkspaceSnapshotEntry,
} from '@/frontend/lib/snapshot-to-sidebar';
import { trpc } from '@/frontend/lib/trpc';
import { useWebSocketTransport } from '@/hooks/use-websocket-transport';
import { buildWebSocketUrl } from '@/lib/websocket-config';

// Type alias for the sidebar cache data shape (matches tRPC-inferred getProjectSummaryState output).
// We use a local type so the updater callbacks can be properly typed without
// running into ServerWorkspace's `createdAt: string | Date` vs the tRPC-inferred `Date`.
type CacheData = {
  workspaces: Record<string, unknown>[];
  reviewCount: number;
};

// Type alias for the kanban cache data shape (matches tRPC-inferred listWithKanbanState output).
type KanbanCacheData = Record<string, unknown>[] | undefined;
type WorkspaceDetailCache = Record<string, unknown> | undefined;

// =============================================================================
// Kanban cache update helpers (extracted to keep handleMessage under complexity limit)
// =============================================================================

/** Build a kanban cache from a snapshot_full message, merging existing entries. */
function buildKanbanCacheFromFull(
  entries: WorkspaceSnapshotEntry[],
  prev: KanbanCacheData
): Record<string, unknown>[] {
  const existingById = new Map<string, Record<string, unknown>>();
  if (prev) {
    for (const w of prev) {
      const id = (w as { id: string }).id;
      existingById.set(id, w);
    }
  }
  return entries
    .filter((e) => e.kanbanColumn !== null)
    .map((e) => mapSnapshotEntryToKanbanWorkspace(e, existingById.get(e.workspaceId)));
}

/** Upsert or remove a single entry in the kanban cache from a snapshot_changed message. */
function upsertKanbanCacheEntry(
  entry: WorkspaceSnapshotEntry,
  prev: KanbanCacheData
): KanbanCacheData {
  // If kanbanColumn is null, workspace doesn't belong on the kanban board -- remove it
  if (entry.kanbanColumn === null) {
    if (!prev) {
      return prev;
    }
    return prev.filter((w) => (w as { id: string }).id !== entry.workspaceId);
  }

  // Find existing cache entry to merge non-snapshot fields
  const existingEntry = prev?.find((w) => (w as { id: string }).id === entry.workspaceId);
  const mapped = mapSnapshotEntryToKanbanWorkspace(entry, existingEntry);

  if (!prev) {
    return [mapped];
  }

  const existingIndex = prev.findIndex((w) => (w as { id: string }).id === entry.workspaceId);
  const items = [...prev];

  if (existingIndex >= 0) {
    items[existingIndex] = mapped;
  } else {
    items.push(mapped);
  }

  return items;
}

/** Remove a workspace from the kanban cache. */
function removeFromKanbanCache(workspaceId: string, prev: KanbanCacheData): KanbanCacheData {
  if (!prev) {
    return prev;
  }
  return prev.filter((w) => (w as { id: string }).id !== workspaceId);
}

function mergeWorkspaceDetailFromSnapshot(
  prev: WorkspaceDetailCache,
  entry: WorkspaceSnapshotEntry
): WorkspaceDetailCache {
  if (!prev) {
    return prev;
  }

  return {
    ...prev,
    prUrl: entry.prUrl,
    prNumber: entry.prNumber,
    prState: entry.prState,
    prCiStatus: entry.prCiStatus,
    ratchetEnabled: entry.ratchetEnabled,
    ratchetState: entry.ratchetState,
    runScriptStatus: entry.runScriptStatus,
    isWorking: entry.isWorking,
    pendingRequestType: entry.pendingRequestType,
    sessionSummaries: entry.sessionSummaries,
    sidebarStatus: entry.sidebarStatus,
    ratchetButtonAnimated: entry.ratchetButtonAnimated,
    flowPhase: entry.flowPhase,
    ciObservation: entry.ciObservation,
  };
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Subscribes to the /snapshots WebSocket endpoint for a given project
 * and updates the React Query caches for `workspace.getProjectSummaryState`
 * (sidebar), `workspace.listWithKanbanState` (kanban board), and
 * `workspace.get` (detail view) whenever snapshot_full, snapshot_changed,
 * or snapshot_removed messages arrive.
 *
 * Returns void -- the hook's side effect is updating the caches.
 */
export function useProjectSnapshotSync(projectId: string | undefined): void {
  const utils = trpc.useUtils();

  const url = projectId ? buildWebSocketUrl('/snapshots', { projectId }) : null;

  const handleMessage = useCallback(
    (data: unknown) => {
      const parsed = SnapshotServerMessageSchema.safeParse(data);
      if (!parsed.success) {
        return;
      }
      const message = parsed.data;
      // Use the raw setData with type assertions to bypass strict tRPC generic
      // inference. The mapped ServerWorkspace shape (with createdAt as Date) is
      // functionally identical to the tRPC-inferred shape, but TypeScript cannot
      // prove this because ServerWorkspace declares createdAt as `string | Date`.
      const { setData } = utils.workspace.getProjectSummaryState;
      const { setData: setKanbanData } = utils.workspace.listWithKanbanState;
      const { setData: setWorkspaceDetailData } = utils.workspace.get;

      switch (message.type) {
        case 'snapshot_full': {
          // Update sidebar cache
          setData({ projectId: message.projectId }, ((prev: CacheData | undefined) => ({
            workspaces: message.entries.map(mapSnapshotEntryToServerWorkspace),
            reviewCount: prev?.reviewCount ?? 0,
          })) as never);

          // Update kanban cache -- filter out entries with null kanbanColumn
          // (matches server behavior: READY workspaces with no sessions are hidden)
          setKanbanData({ projectId: message.projectId }, ((prev: KanbanCacheData) =>
            buildKanbanCacheFromFull(message.entries, prev)) as never);

          for (const entry of message.entries) {
            setWorkspaceDetailData({ id: entry.workspaceId }, ((prev: WorkspaceDetailCache) =>
              mergeWorkspaceDetailFromSnapshot(prev, entry)) as never);
          }

          // Invalidate workspace.list cache so table view refetches with fresh data
          utils.workspace.list.invalidate({ projectId: message.projectId });
          break;
        }

        case 'snapshot_changed': {
          if (!projectId) {
            break;
          }

          // Update sidebar cache
          setData({ projectId }, ((prev: CacheData | undefined) => {
            if (!prev) {
              return {
                workspaces: [mapSnapshotEntryToServerWorkspace(message.entry)],
                reviewCount: 0,
              };
            }

            const mapped = mapSnapshotEntryToServerWorkspace(message.entry);
            const existingIndex = prev.workspaces.findIndex(
              (w) => (w as { id: string }).id === mapped.id
            );
            const workspaces = [...prev.workspaces];

            if (existingIndex >= 0) {
              workspaces[existingIndex] = mapped as unknown as Record<string, unknown>;
            } else {
              workspaces.push(mapped as unknown as Record<string, unknown>);
            }

            return { workspaces, reviewCount: prev.reviewCount };
          }) as never);

          // Update kanban cache
          setKanbanData({ projectId }, ((prev: KanbanCacheData) =>
            upsertKanbanCacheEntry(message.entry, prev)) as never);

          setWorkspaceDetailData({ id: message.entry.workspaceId }, ((prev: WorkspaceDetailCache) =>
            mergeWorkspaceDetailFromSnapshot(prev, message.entry)) as never);

          // Invalidate workspace.list cache so table view refetches with fresh data
          utils.workspace.list.invalidate({ projectId });
          break;
        }

        case 'snapshot_removed': {
          if (!projectId) {
            break;
          }

          // Update sidebar cache
          setData({ projectId }, ((prev: CacheData | undefined) => {
            if (!prev) {
              return prev;
            }
            return {
              workspaces: prev.workspaces.filter(
                (w) => (w as { id: string }).id !== message.workspaceId
              ),
              reviewCount: prev.reviewCount,
            };
          }) as never);

          // Update kanban cache
          setKanbanData({ projectId }, ((prev: KanbanCacheData) =>
            removeFromKanbanCache(message.workspaceId, prev)) as never);

          // Clear workspace detail cache so the detail view does not retain stale data
          setWorkspaceDetailData({ id: message.workspaceId }, undefined as never);

          // Invalidate workspace.list cache so table view refetches with fresh data
          utils.workspace.list.invalidate({ projectId });
          break;
        }
      }
    },
    [projectId, utils]
  );

  useWebSocketTransport({
    url,
    onMessage: handleMessage,
    queuePolicy: 'drop',
  });
}
