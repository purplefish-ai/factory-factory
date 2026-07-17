/**
 * React hook that syncs /snapshots WebSocket messages into the
 * getProjectSummaryState (sidebar), listWithKanbanState (kanban), and
 * workspace.get (detail header/session runtime) React Query cache entries.
 *
 * Merge strategy — one strategy per cache per message:
 * - snapshot_changed / snapshot_removed deltas are pure setData patches;
 *   they never trigger invalidation refetches.
 * - snapshot_full is the (re)connect baseline. Any baseline after a
 *   project's first follows a gap (network reconnect, or a switch away and
 *   back) during which deltas were dropped, and snapshot entries don't carry
 *   every DB-backed field, so those baselines additionally invalidate the
 *   workspace caches to let them self-heal.
 *
 * Follows the use-log-stream.ts pattern: receive-only WebSocket hook with
 * drop queue policy (no outbound messages, reconnect discards stale data).
 */

import type { inferRouterOutputs } from '@trpc/server';
import { useCallback, useRef } from 'react';
import { overridePendingRatchetToggle } from '@/client/lib/ratchet-toggle-cache';
import {
  mergeProjectSnapshotIntoWorkspaceDetail,
  projectSnapshotToKanbanWorkspace,
  projectSnapshotToSidebarWorkspace,
} from '@/client/lib/snapshot-to-workspace';
import { type AppRouter, trpc } from '@/client/lib/trpc';
import { useWebSocketChannel } from '@/hooks/use-websocket-channel';
import { buildWebSocketUrl } from '@/lib/websocket-config';
import {
  type SnapshotChangedMessage,
  type SnapshotFullMessage,
  type SnapshotRemovedMessage,
  type SnapshotServerMessage,
  SnapshotServerMessageSchema,
  type WorkspaceSnapshotEntry,
} from '@/shared/workspace-snapshot';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type ProjectSummaryCache = RouterOutputs['workspace']['getProjectSummaryState'];
type SidebarWorkspace = ProjectSummaryCache['workspaces'][number];
type KanbanCacheData = RouterOutputs['workspace']['listWithKanbanState'] | undefined;
type KanbanWorkspace = NonNullable<KanbanCacheData>[number];
type PendingRequestType = WorkspaceSnapshotEntry['pendingRequestType'];
type TrpcUtils = ReturnType<typeof trpc.useUtils>;

// NOTE: `stateComputedAt` is DB-backed kanban-state timing and is preserved by
// snapshot mappers; snapshot transport recency uses `snapshotComputedAt`.

// =============================================================================
// Kanban cache update helpers (extracted to keep handleMessage under complexity limit)
// =============================================================================

/** Build a kanban cache from a snapshot_full message, merging existing entries. */
function buildKanbanCacheFromFull(
  entries: WorkspaceSnapshotEntry[],
  prev: KanbanCacheData
): NonNullable<KanbanCacheData> {
  const existingById = new Map<string, KanbanWorkspace>();
  if (prev) {
    for (const w of prev) {
      existingById.set(w.id, w);
    }
  }
  return entries
    .filter((e) => e.kanbanColumn !== null)
    .map((e) => projectSnapshotToKanbanWorkspace(e, existingById.get(e.workspaceId)));
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
    return prev.filter((w) => w.id !== entry.workspaceId);
  }

  // Find existing cache entry to merge non-snapshot fields
  const existingEntry = prev?.find((w) => w.id === entry.workspaceId);
  const mapped = projectSnapshotToKanbanWorkspace(entry, existingEntry);

  if (!prev) {
    return [mapped];
  }

  const existingIndex = prev.findIndex((w) => w.id === entry.workspaceId);
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
  return prev.filter((w) => w.id !== workspaceId);
}

function triggerWorkspaceAttention(workspaceId: string): void {
  const event = new CustomEvent('workspace-attention-required', {
    detail: { workspaceId },
  });

  if (typeof globalThis.dispatchEvent === 'function') {
    globalThis.dispatchEvent(event);
    return;
  }

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(event);
  }
}

/**
 * Invalidates the workspace caches after any snapshot_full baseline past a
 * project's first. The snapshot patches keep the UI instant; the refetches
 * restore DB-backed fields the snapshot doesn't carry (issue links, etc.)
 * and drop workspace.get entries for workspaces that were archived while
 * no socket for the project was connected.
 */
function healWorkspaceCachesAfterReconnect(utils: TrpcUtils, projectId: string): void {
  utils.workspace.get.invalidate();
  utils.workspace.list.invalidate({ projectId });
  utils.workspace.getProjectSummaryState.invalidate({ projectId });
  utils.workspace.listWithKanbanState.invalidate({ projectId });
}

function seedPendingRequests(
  pendingRequests: Map<string, PendingRequestType>,
  entries: WorkspaceSnapshotEntry[]
): void {
  pendingRequests.clear();
  for (const entry of entries) {
    pendingRequests.set(entry.workspaceId, entry.pendingRequestType);
  }
}

function maybeTriggerPendingRequestAttention(
  pendingRequests: Map<string, PendingRequestType>,
  entry: WorkspaceSnapshotEntry
): void {
  const previousPending = pendingRequests.get(entry.workspaceId);
  const nextPending = entry.pendingRequestType;
  const pendingTransitionedToRequiredInput = !previousPending && Boolean(nextPending);
  if (pendingTransitionedToRequiredInput) {
    triggerWorkspaceAttention(entry.workspaceId);
  }
  pendingRequests.set(entry.workspaceId, nextPending);
}

function applySnapshotFullMessage(
  utils: TrpcUtils,
  message: SnapshotFullMessage,
  pendingRequests: Map<string, PendingRequestType>
): void {
  const entries = message.entries.map(overridePendingRatchetToggle);

  seedPendingRequests(pendingRequests, entries);

  const { setData } = utils.workspace.getProjectSummaryState;
  const { setData: setKanbanData } = utils.workspace.listWithKanbanState;
  const { setData: setWorkspaceDetailData } = utils.workspace.get;

  setData({ projectId: message.projectId }, (prev) => {
    const existingById = new Map<string, SidebarWorkspace>();
    if (prev) {
      for (const w of prev.workspaces) {
        existingById.set(w.id, w);
      }
    }
    return {
      workspaces: entries.map((e) =>
        projectSnapshotToSidebarWorkspace(e, existingById.get(e.workspaceId))
      ),
      reviewCount: message.reviewCount ?? prev?.reviewCount ?? 0,
    };
  });

  setKanbanData({ projectId: message.projectId }, (prev) =>
    buildKanbanCacheFromFull(entries, prev)
  );

  for (const entry of entries) {
    setWorkspaceDetailData({ id: entry.workspaceId }, (prev) =>
      mergeProjectSnapshotIntoWorkspaceDetail(entry, prev)
    );
  }
}

function applySnapshotChangedMessage(
  utils: TrpcUtils,
  projectId: string,
  message: SnapshotChangedMessage,
  pendingRequests: Map<string, PendingRequestType>
): void {
  const entry = overridePendingRatchetToggle(message.entry);

  maybeTriggerPendingRequestAttention(pendingRequests, entry);

  const { setData } = utils.workspace.getProjectSummaryState;
  const { setData: setKanbanData } = utils.workspace.listWithKanbanState;
  const { setData: setWorkspaceDetailData } = utils.workspace.get;

  setData({ projectId }, (prev) => {
    if (!prev) {
      return {
        workspaces: [projectSnapshotToSidebarWorkspace(entry)],
        reviewCount: message.reviewCount ?? 0,
      };
    }

    const existingEntry = prev.workspaces.find((w) => w.id === entry.workspaceId);
    const mapped = projectSnapshotToSidebarWorkspace(entry, existingEntry);
    const existingIndex = prev.workspaces.findIndex((w) => w.id === mapped.id);
    const workspaces = [...prev.workspaces];

    if (existingIndex >= 0) {
      workspaces[existingIndex] = mapped;
    } else {
      workspaces.push(mapped);
    }

    return { workspaces, reviewCount: message.reviewCount ?? prev.reviewCount };
  });

  setKanbanData({ projectId }, (prev) => upsertKanbanCacheEntry(entry, prev));

  setWorkspaceDetailData({ id: entry.workspaceId }, (prev) =>
    mergeProjectSnapshotIntoWorkspaceDetail(entry, prev)
  );
}

function applySnapshotRemovedMessage(
  utils: TrpcUtils,
  projectId: string,
  message: SnapshotRemovedMessage,
  pendingRequests: Map<string, PendingRequestType>
): void {
  pendingRequests.delete(message.workspaceId);

  const { setData } = utils.workspace.getProjectSummaryState;
  const { setData: setKanbanData } = utils.workspace.listWithKanbanState;
  const { setData: setWorkspaceDetailData } = utils.workspace.get;

  setData({ projectId }, (prev) => {
    if (!prev) {
      return prev;
    }
    return {
      workspaces: prev.workspaces.filter((w) => w.id !== message.workspaceId),
      reviewCount: message.reviewCount ?? prev.reviewCount,
    };
  });

  setKanbanData({ projectId }, (prev) => removeFromKanbanCache(message.workspaceId, prev));

  setWorkspaceDetailData({ id: message.workspaceId }, undefined);
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
  const previousPendingRequestsRef = useRef<Map<string, PendingRequestType>>(new Map());
  // A project's first snapshot_full arrives alongside its initial query
  // fetches, so it needs no refetch. Every later baseline for that project
  // follows a gap — a network reconnect or a switch away and back — during
  // which deltas were dropped, so it must also refetch-heal the
  // staleTime: Infinity workspace caches. Keyed per project because the hook
  // survives project switches.
  const baselineProjectsRef = useRef<Set<string>>(new Set());

  const url = projectId ? buildWebSocketUrl('/snapshots', { projectId }) : null;

  const handleMessage = useCallback(
    (message: SnapshotServerMessage) => {
      switch (message.type) {
        case 'snapshot_full': {
          applySnapshotFullMessage(utils, message, previousPendingRequestsRef.current);
          if (baselineProjectsRef.current.has(message.projectId)) {
            healWorkspaceCachesAfterReconnect(utils, message.projectId);
          } else {
            baselineProjectsRef.current.add(message.projectId);
          }
          break;
        }

        case 'snapshot_changed': {
          if (!projectId) {
            break;
          }
          applySnapshotChangedMessage(
            utils,
            projectId,
            message,
            previousPendingRequestsRef.current
          );
          break;
        }

        case 'snapshot_removed': {
          if (!projectId) {
            break;
          }
          applySnapshotRemovedMessage(
            utils,
            projectId,
            message,
            previousPendingRequestsRef.current
          );
          break;
        }
      }
    },
    [projectId, utils]
  );

  useWebSocketChannel({
    url,
    schema: SnapshotServerMessageSchema,
    onMessage: handleMessage,
    queuePolicy: 'drop',
  });
}
