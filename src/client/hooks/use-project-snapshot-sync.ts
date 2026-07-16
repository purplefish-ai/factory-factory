/**
 * React hook that syncs /snapshots WebSocket messages into the
 * getProjectSummaryState (sidebar), listWithKanbanState (kanban), and
 * workspace.get (detail header/session runtime) React Query cache entries.
 *
 * Merge strategy — one strategy per cache per message:
 * - snapshot_changed / snapshot_removed deltas are pure setData patches;
 *   they never trigger invalidation refetches.
 * - snapshot_full is the (re)connect baseline. After a disconnect the
 *   staleTime: Infinity workspace caches may hold state whose deltas were
 *   dropped (queuePolicy: 'drop'), and snapshot entries don't carry every
 *   DB-backed field, so the first baseline after a disconnect additionally
 *   invalidates the workspace caches to let them self-heal.
 *
 * Follows the use-log-stream.ts pattern: receive-only WebSocket hook with
 * drop queue policy (no outbound messages, reconnect discards stale data).
 */

import { useCallback, useRef } from 'react';
import type { z } from 'zod';
import { overridePendingRatchetToggle } from '@/client/lib/ratchet-toggle-cache';
import { mapSnapshotEntryToKanbanWorkspace } from '@/client/lib/snapshot-to-kanban';
import {
  mapSnapshotEntryToServerWorkspace,
  type SnapshotChangedMessage,
  type SnapshotFullMessage,
  type SnapshotRemovedMessage,
  SnapshotServerMessageSchema,
  type WorkspaceSnapshotEntry,
} from '@/client/lib/snapshot-to-sidebar';
import { trpc } from '@/client/lib/trpc';
import { useWebSocketChannel } from '@/hooks/use-websocket-channel';
import { buildWebSocketUrl } from '@/lib/websocket-config';

type CacheWorkspace = ReturnType<typeof mapSnapshotEntryToServerWorkspace>;

// Type alias for the sidebar cache data shape (matches tRPC-inferred getProjectSummaryState output).
// We use a local type so the updater callbacks can be properly typed without
// running into ServerWorkspace's `createdAt: string | Date` vs the tRPC-inferred `Date`.
type CacheData = {
  workspaces: CacheWorkspace[];
  reviewCount: number;
};

// Type alias for the kanban cache data shape (matches tRPC-inferred listWithKanbanState output).
type KanbanCacheData = Record<string, unknown>[] | undefined;
type WorkspaceDetailCache = Record<string, unknown> | undefined;
type PendingRequestType = 'plan_approval' | 'user_question' | 'permission_request' | null;
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
    statusReason: entry.statusReason,
  };
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
 * Invalidates the workspace caches after the first snapshot_full baseline
 * that follows a disconnect. The snapshot patches keep the UI instant; the
 * refetches restore DB-backed fields the snapshot doesn't carry (issue
 * links, etc.) and drop workspace.get entries for workspaces that were
 * archived while disconnected.
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

  setData({ projectId: message.projectId }, ((prev: CacheData | undefined) => {
    const existingById = new Map<string, CacheWorkspace>();
    if (prev) {
      for (const w of prev.workspaces) {
        existingById.set(w.id, w);
      }
    }
    return {
      workspaces: entries.map((e) =>
        mapSnapshotEntryToServerWorkspace(e, existingById.get(e.workspaceId))
      ),
      reviewCount: message.reviewCount ?? prev?.reviewCount ?? 0,
    };
  }) as never);

  setKanbanData({ projectId: message.projectId }, ((prev: KanbanCacheData) =>
    buildKanbanCacheFromFull(entries, prev)) as never);

  for (const entry of entries) {
    setWorkspaceDetailData({ id: entry.workspaceId }, ((prev: WorkspaceDetailCache) =>
      mergeWorkspaceDetailFromSnapshot(prev, entry)) as never);
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

  setData({ projectId }, ((prev: CacheData | undefined) => {
    if (!prev) {
      return {
        workspaces: [mapSnapshotEntryToServerWorkspace(entry)],
        reviewCount: message.reviewCount ?? 0,
      };
    }

    const existingEntry = prev.workspaces.find((w) => w.id === entry.workspaceId);
    const mapped = mapSnapshotEntryToServerWorkspace(entry, existingEntry);
    const existingIndex = prev.workspaces.findIndex((w) => w.id === mapped.id);
    const workspaces = [...prev.workspaces];

    if (existingIndex >= 0) {
      workspaces[existingIndex] = mapped;
    } else {
      workspaces.push(mapped);
    }

    return { workspaces, reviewCount: message.reviewCount ?? prev.reviewCount };
  }) as never);

  setKanbanData({ projectId }, ((prev: KanbanCacheData) =>
    upsertKanbanCacheEntry(entry, prev)) as never);

  setWorkspaceDetailData({ id: entry.workspaceId }, ((prev: WorkspaceDetailCache) =>
    mergeWorkspaceDetailFromSnapshot(prev, entry)) as never);
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

  setData({ projectId }, ((prev: CacheData | undefined) => {
    if (!prev) {
      return prev;
    }
    return {
      workspaces: prev.workspaces.filter((w) => w.id !== message.workspaceId),
      reviewCount: message.reviewCount ?? prev.reviewCount,
    };
  }) as never);

  setKanbanData({ projectId }, ((prev: KanbanCacheData) =>
    removeFromKanbanCache(message.workspaceId, prev)) as never);

  setWorkspaceDetailData({ id: message.workspaceId }, undefined as never);
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
  // Deltas may have been dropped while disconnected, so the next snapshot_full
  // baseline must also refetch-heal the staleTime: Infinity workspace caches.
  const staleSinceDisconnectRef = useRef(false);

  const url = projectId ? buildWebSocketUrl('/snapshots', { projectId }) : null;

  const handleDisconnected = useCallback(() => {
    staleSinceDisconnectRef.current = true;
  }, []);

  const handleMessage = useCallback(
    (message: z.infer<typeof SnapshotServerMessageSchema>) => {
      switch (message.type) {
        case 'snapshot_full': {
          applySnapshotFullMessage(utils, message, previousPendingRequestsRef.current);
          if (staleSinceDisconnectRef.current) {
            staleSinceDisconnectRef.current = false;
            healWorkspaceCachesAfterReconnect(utils, message.projectId);
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
    onDisconnected: handleDisconnected,
    queuePolicy: 'drop',
  });
}
