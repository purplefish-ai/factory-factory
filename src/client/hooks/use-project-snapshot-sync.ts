/**
 * React hook that syncs /snapshots WebSocket messages into both the
 * getProjectSummaryState (sidebar), listWithKanbanState (kanban), and
 * workspace.get (detail header/session runtime) React Query cache entries.
 * Also invalidates the workspace.list and workspace.listWithRuntimeState caches
 * so table/list views refetch with fresh data on every snapshot event.
 *
 * Follows the use-dev-logs.ts pattern: receive-only WebSocket hook with
 * drop queue policy (no outbound messages, reconnect discards stale data).
 */

import { useCallback, useRef } from 'react';
import { mapSnapshotEntryToKanbanWorkspace } from '@/client/lib/snapshot-to-kanban';
import {
  mapSnapshotEntryToServerWorkspace,
  type SnapshotChangedMessage,
  type SnapshotFullAllMessage,
  type SnapshotFullMessage,
  type SnapshotRemovedMessage,
  SnapshotServerMessageSchema,
  type WorkspaceSnapshotEntry,
} from '@/client/lib/snapshot-to-sidebar';
import { trpc } from '@/client/lib/trpc';
import { useWebSocketTransport } from '@/hooks/use-websocket-transport';
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

function handleSnapshotChangedCase(
  utils: TrpcUtils,
  message: SnapshotChangedMessage,
  projectId: string | undefined,
  viewMode: 'single' | 'all',
  pendingRequests: Map<string, PendingRequestType>
): void {
  const pid = message.projectId ?? projectId;
  if (!pid) {
    return;
  }
  if (viewMode === 'all' && message.projectId) {
    applyAllProjectsChangedMessage(
      utils,
      message as SnapshotChangedMessage & { projectId: string }
    );
  }
  applySnapshotChangedMessage(utils, pid, message, pendingRequests);
}

function handleSnapshotRemovedCase(
  utils: TrpcUtils,
  message: SnapshotRemovedMessage,
  projectId: string | undefined,
  viewMode: 'single' | 'all',
  pendingRequests: Map<string, PendingRequestType>
): void {
  const pid = message.projectId ?? projectId;
  if (!pid) {
    return;
  }
  if (viewMode === 'all' && message.projectId) {
    applyAllProjectsRemovedMessage(
      utils,
      message as SnapshotRemovedMessage & { projectId: string }
    );
  }
  applySnapshotRemovedMessage(utils, pid, message, pendingRequests);
}

function invalidateWorkspaceListCaches(utils: TrpcUtils, projectId: string): void {
  utils.workspace.list.invalidate({ projectId });
  utils.workspace.listWithRuntimeState.invalidate({ projectId });
}

// =============================================================================
// All-projects cache update helpers
// =============================================================================

type AllProjectsCacheData =
  | Array<{
      project: { id: string; slug: string; name: string };
      workspaces: CacheWorkspace[];
      reviewCount: number;
    }>
  | undefined;

function applySnapshotFullAllMessage(utils: TrpcUtils, message: SnapshotFullAllMessage): void {
  utils.workspace.getAllProjectsSummaryState.setData({}, ((prev: AllProjectsCacheData) => {
    // Group entries by projectId
    const byProject = new Map<string, typeof message.entries>();
    for (const entry of message.entries) {
      const list = byProject.get(entry.projectId) ?? [];
      list.push(entry);
      byProject.set(entry.projectId, list);
    }

    if (!prev) {
      return prev;
    }

    return prev.map((projectData) => {
      const entries = byProject.get(projectData.project.id) ?? [];
      const existingById = new Map<string, CacheWorkspace>();
      for (const w of projectData.workspaces) {
        existingById.set(w.id, w);
      }
      return {
        ...projectData,
        workspaces: entries.map((e) =>
          mapSnapshotEntryToServerWorkspace(e, existingById.get(e.workspaceId))
        ),
      };
    });
  }) as never);
}

function applyAllProjectsChangedMessage(
  utils: TrpcUtils,
  message: SnapshotChangedMessage & { projectId: string }
): void {
  utils.workspace.getAllProjectsSummaryState.setData({}, ((prev: AllProjectsCacheData) => {
    if (!prev) {
      return prev;
    }
    return prev.map((projectData) => {
      if (projectData.project.id !== message.projectId) {
        return projectData;
      }
      const existingEntry = projectData.workspaces.find((w) => w.id === message.entry.workspaceId);
      const mapped = mapSnapshotEntryToServerWorkspace(message.entry, existingEntry);
      const existingIndex = projectData.workspaces.findIndex((w) => w.id === mapped.id);
      const workspaces = [...projectData.workspaces];
      if (existingIndex >= 0) {
        workspaces[existingIndex] = mapped;
      } else {
        workspaces.push(mapped);
      }
      return { ...projectData, workspaces };
    });
  }) as never);
}

function applyAllProjectsRemovedMessage(
  utils: TrpcUtils,
  message: SnapshotRemovedMessage & { projectId: string }
): void {
  utils.workspace.getAllProjectsSummaryState.setData({}, ((prev: AllProjectsCacheData) => {
    if (!prev) {
      return prev;
    }
    return prev.map((projectData) => {
      if (projectData.project.id !== message.projectId) {
        return projectData;
      }
      return {
        ...projectData,
        workspaces: projectData.workspaces.filter((w) => w.id !== message.workspaceId),
      };
    });
  }) as never);
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
  seedPendingRequests(pendingRequests, message.entries);

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
      workspaces: message.entries.map((e) =>
        mapSnapshotEntryToServerWorkspace(e, existingById.get(e.workspaceId))
      ),
      reviewCount: prev?.reviewCount ?? 0,
    };
  }) as never);

  setKanbanData({ projectId: message.projectId }, ((prev: KanbanCacheData) =>
    buildKanbanCacheFromFull(message.entries, prev)) as never);

  for (const entry of message.entries) {
    setWorkspaceDetailData({ id: entry.workspaceId }, ((prev: WorkspaceDetailCache) =>
      mergeWorkspaceDetailFromSnapshot(prev, entry)) as never);
  }

  invalidateWorkspaceListCaches(utils, message.projectId);
}

function applySnapshotChangedMessage(
  utils: TrpcUtils,
  projectId: string,
  message: SnapshotChangedMessage,
  pendingRequests: Map<string, PendingRequestType>
): void {
  maybeTriggerPendingRequestAttention(pendingRequests, message.entry);

  const { setData } = utils.workspace.getProjectSummaryState;
  const { setData: setKanbanData } = utils.workspace.listWithKanbanState;
  const { setData: setWorkspaceDetailData } = utils.workspace.get;

  setData({ projectId }, ((prev: CacheData | undefined) => {
    if (!prev) {
      return {
        workspaces: [mapSnapshotEntryToServerWorkspace(message.entry)],
        reviewCount: 0,
      };
    }

    const existingEntry = prev.workspaces.find((w) => w.id === message.entry.workspaceId);
    const mapped = mapSnapshotEntryToServerWorkspace(message.entry, existingEntry);
    const existingIndex = prev.workspaces.findIndex((w) => w.id === mapped.id);
    const workspaces = [...prev.workspaces];

    if (existingIndex >= 0) {
      workspaces[existingIndex] = mapped;
    } else {
      workspaces.push(mapped);
    }

    return { workspaces, reviewCount: prev.reviewCount };
  }) as never);

  setKanbanData({ projectId }, ((prev: KanbanCacheData) =>
    upsertKanbanCacheEntry(message.entry, prev)) as never);

  setWorkspaceDetailData({ id: message.entry.workspaceId }, ((prev: WorkspaceDetailCache) =>
    mergeWorkspaceDetailFromSnapshot(prev, message.entry)) as never);

  invalidateWorkspaceListCaches(utils, projectId);
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
      reviewCount: prev.reviewCount,
    };
  }) as never);

  setKanbanData({ projectId }, ((prev: KanbanCacheData) =>
    removeFromKanbanCache(message.workspaceId, prev)) as never);

  setWorkspaceDetailData({ id: message.workspaceId }, undefined as never);

  invalidateWorkspaceListCaches(utils, projectId);
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
 * When viewMode is 'all', connects with projectId=__all__ and updates
 * the getAllProjectsSummaryState cache instead.
 *
 * Returns void -- the hook's side effect is updating the caches.
 */
export function useProjectSnapshotSync(
  projectId: string | undefined,
  viewMode: 'single' | 'all' = 'single'
): void {
  const utils = trpc.useUtils();
  const previousPendingRequestsRef = useRef<Map<string, PendingRequestType>>(new Map());

  const effectiveProjectId = viewMode === 'all' ? '__all__' : projectId;
  const url = effectiveProjectId
    ? buildWebSocketUrl('/snapshots', { projectId: effectiveProjectId })
    : null;

  const handleMessage = useCallback(
    (data: unknown) => {
      const parsed = SnapshotServerMessageSchema.safeParse(data);
      if (!parsed.success) {
        return;
      }
      const message = parsed.data;

      switch (message.type) {
        case 'snapshot_full_all': {
          applySnapshotFullAllMessage(utils, message);
          break;
        }

        case 'snapshot_full': {
          applySnapshotFullMessage(utils, message, previousPendingRequestsRef.current);
          break;
        }

        case 'snapshot_changed': {
          handleSnapshotChangedCase(
            utils,
            message,
            projectId,
            viewMode,
            previousPendingRequestsRef.current
          );
          break;
        }

        case 'snapshot_removed': {
          handleSnapshotRemovedCase(
            utils,
            message,
            projectId,
            viewMode,
            previousPendingRequestsRef.current
          );
          break;
        }
      }
    },
    [projectId, viewMode, utils]
  );

  useWebSocketTransport({
    url,
    onMessage: handleMessage,
    queuePolicy: 'drop',
  });
}
