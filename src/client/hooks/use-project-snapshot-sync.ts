import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import type { inferRouterOutputs } from '@trpc/server';
/**
 * React hook that syncs /snapshots WebSocket messages into the
 * workspace.listForProject (sidebar + kanban) and workspace.get (detail
 * header/session runtime) React Query cache entries.
 *
 * Merge strategy — one strategy per cache per message:
 * - Ordinary snapshot_changed / snapshot_removed deltas patch caches directly.
 *   Ready workspaces missing a cached worktree path refetch the project list
 *   once so PR review actions can use the actual provisioned path.
 * - snapshot_full is the (re)connect baseline. Any baseline after a
 *   project's first follows a gap (network reconnect, or a switch away and
 *   back) during which deltas were dropped, and snapshot entries don't carry
 *   every DB-backed field, so those baselines additionally invalidate the
 *   workspace caches to let them self-heal.
 *
 * Follows the use-log-stream.ts pattern: receive-only WebSocket hook with
 * drop queue policy (no outbound messages, reconnect discards stale data).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { runInBackground } from '@/client/lib/background-task';
import { mergeProjectSnapshotIntoWorkspaceDetail } from '@/client/lib/snapshot-to-workspace';
import { type AppRouter, trpc } from '@/client/lib/trpc';
import {
  getProjectWorkspaceCacheReconciler,
  projectWorkspaceDetailQueryFilter,
  type ProjectWorkspaceCacheReconciler,
  type WorkspaceConnection,
} from '@/client/lib/workspace-cache-reconciler';
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
type PendingRequestType = WorkspaceSnapshotEntry['pendingRequestType'];
type TrpcUtils = ReturnType<typeof trpc.useUtils>;

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
  runInBackground(utils.workspace.get.invalidate(), 'Could not refresh data');
  runInBackground(
    utils.workspace.listForProject.invalidate({ projectId }),
    'Could not refresh data'
  );
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

/**
 * A snapshot entry carries only live fields. Mutation-sourced fields —
 * including `githubIssueNumber` and `linearIssueId`, which the Todo column
 * matches issues against — fall back to nulls for a workspace no fetch has
 * returned yet, so the workspace lands on the board while its issue is still
 * in Todo. Invalidating once at the point of introduction repairs every such
 * field rather than the two that happen to hurt. `alreadyInvalidated` caps it
 * at one invalidation per previously-unseen workspace id, so a burst of
 * snapshot messages for the same new workspace doesn't trigger a refetch
 * storm.
 */
function invalidateForUnknownWorkspaces(
  utils: TrpcUtils,
  projectId: string,
  entriesToCheck: WorkspaceSnapshotEntry[],
  knownWorkspaceIds: Set<string>,
  alreadyInvalidated: Set<string>
): void {
  const introduced = entriesToCheck.filter(
    (entry) =>
      !(alreadyInvalidated.has(entry.workspaceId) || knownWorkspaceIds.has(entry.workspaceId))
  );
  if (introduced.length === 0) {
    return;
  }

  // Marked before the refetch, not after: the guard exists to collapse a burst
  // of messages that arrive while the request is still in flight, and marking
  // on success would let every one of them start its own.
  for (const entry of introduced) {
    alreadyInvalidated.add(entry.workspaceId);
  }

  // Releasing the marks on failure is what keeps the guard from turning a
  // transient error into permanent staleness. Without it, a refetch that fails
  // leaves these workspaces marked as repaired forever, so their issue-link
  // fields stay null and their issues sit in Todo alongside the board card
  // until something else forces a refetch.
  void utils.workspace.listForProject.invalidate({ projectId }).catch(() => {
    for (const entry of introduced) {
      alreadyInvalidated.delete(entry.workspaceId);
    }
  });
}

/** Snapshots carry readiness but omit the worktree path required for PR review. */
function healReadyWorktreePaths(
  utils: TrpcUtils,
  projectId: string,
  entries: readonly WorkspaceSnapshotEntry[],
  knownWorkspaceIds: Set<string>,
  repairedWorkspaceIds: Set<string>
): void {
  const cachedById = new Map(
    utils.workspace.listForProject
      .getData({ projectId })
      ?.workspaces.map((workspace) => [workspace.id, workspace])
  );
  const missingPaths = entries.filter(
    (entry) =>
      entry.status === 'READY' &&
      knownWorkspaceIds.has(entry.workspaceId) &&
      !cachedById.get(entry.workspaceId)?.worktreePath &&
      !repairedWorkspaceIds.has(entry.workspaceId)
  );
  if (!missingPaths.length) {
    return;
  }
  for (const entry of missingPaths) {
    repairedWorkspaceIds.add(entry.workspaceId);
  }
  void utils.workspace.listForProject.invalidate({ projectId }).then(
    () => {
      const refreshedById = new Map(
        utils.workspace.listForProject
          .getData({ projectId })
          ?.workspaces.map((workspace) => [workspace.id, workspace])
      );
      for (const entry of missingPaths) {
        if (!refreshedById.get(entry.workspaceId)?.worktreePath) {
          repairedWorkspaceIds.delete(entry.workspaceId);
        }
      }
    },
    () => {
      for (const entry of missingPaths) {
        repairedWorkspaceIds.delete(entry.workspaceId);
      }
    }
  );
}

/** Reset existing detail observers once per departure from the live list. */
function resetRemovedWorkspaceDetail(
  queryClient: QueryClient,
  workspaceId: string,
  removedWorkspaceIds: Set<string>
): void {
  if (removedWorkspaceIds.has(workspaceId)) {
    return;
  }
  removedWorkspaceIds.add(workspaceId);
  // Unlike setData(undefined), reset clears old data and synchronously cancels
  // its request before active observers refetch persisted (possibly archived)
  // detail. No initialData is configured for workspace.get.
  runInBackground(
    queryClient.resetQueries({
      queryKey: getQueryKey(trpc.workspace.get, { id: workspaceId }, 'query'),
      exact: true,
    }),
    'Could not refresh data'
  );
}

/** A rollback summary must not race a removal's outstanding detail fetch. */
function mergeLiveWorkspaceDetail(
  utils: TrpcUtils,
  queryClient: QueryClient,
  entry: WorkspaceSnapshotEntry,
  removedWorkspaceIds: Set<string>
): void {
  const reintroduced = removedWorkspaceIds.delete(entry.workspaceId);
  const filter = {
    queryKey: getQueryKey(trpc.workspace.get, { id: entry.workspaceId }, 'query'),
    exact: true,
  };
  if (reintroduced) {
    // Cancellation takes effect synchronously; do not await before merging.
    runInBackground(queryClient.cancelQueries(filter), 'Could not refresh data');
  }
  utils.workspace.get.setData({ id: entry.workspaceId }, (prev) =>
    mergeProjectSnapshotIntoWorkspaceDetail(entry, prev)
  );
  if (reintroduced) {
    // Reset may have cleared the full detail, which a summary cannot recreate.
    runInBackground(
      queryClient.refetchQueries({ ...filter, type: 'active' }),
      'Could not refresh data'
    );
  }
}

function applySnapshotFullMessage(
  utils: TrpcUtils,
  queryClient: QueryClient,
  message: SnapshotFullMessage,
  pendingRequests: Map<string, PendingRequestType>,
  alreadyInvalidated: Set<string>,
  repairedWorktreePaths: Set<string>,
  removedWorkspaceIds: Set<string>,
  reconciler: ProjectWorkspaceCacheReconciler,
  connection: WorkspaceConnection
): void {
  const entries = message.entries;

  seedPendingRequests(pendingRequests, entries);

  const knownWorkspaceIds = new Set(
    (
      utils.workspace.listForProject.getData({ projectId: message.projectId })?.workspaces ?? []
    ).map((w) => w.id)
  );

  const liveWorkspaceIds = new Set(entries.map((entry) => entry.workspaceId));
  const removalCandidates = new Set(knownWorkspaceIds);
  // A detail can outlive an empty/evicted project list across navigation.
  for (const [, detail] of queryClient.getQueriesData<RouterOutputs['workspace']['get']>({
    queryKey: getQueryKey(trpc.workspace.get, undefined, 'query'),
  })) {
    if (
      detail?.projectId === message.projectId &&
      detail.status !== 'ARCHIVING' &&
      detail.status !== 'ARCHIVED'
    ) {
      removalCandidates.add(detail.id);
    }
  }
  for (const workspaceId of removalCandidates) {
    if (!liveWorkspaceIds.has(workspaceId)) {
      resetRemovedWorkspaceDetail(queryClient, workspaceId, removedWorkspaceIds);
    }
  }
  reconciler.apply(connection, message);

  invalidateForUnknownWorkspaces(
    utils,
    message.projectId,
    entries,
    knownWorkspaceIds,
    alreadyInvalidated
  );

  healReadyWorktreePaths(
    utils,
    message.projectId,
    entries,
    knownWorkspaceIds,
    repairedWorktreePaths
  );

  for (const entry of entries) {
    mergeLiveWorkspaceDetail(utils, queryClient, entry, removedWorkspaceIds);
  }
}

function applySnapshotChangedMessage(
  utils: TrpcUtils,
  queryClient: QueryClient,
  projectId: string,
  message: SnapshotChangedMessage,
  pendingRequests: Map<string, PendingRequestType>,
  alreadyInvalidated: Set<string>,
  repairedWorktreePaths: Set<string>,
  removedWorkspaceIds: Set<string>,
  reconciler: ProjectWorkspaceCacheReconciler,
  connection: WorkspaceConnection
): void {
  const entry = message.entry;

  maybeTriggerPendingRequestAttention(pendingRequests, entry);

  const knownWorkspaceIds = new Set(
    (utils.workspace.listForProject.getData({ projectId })?.workspaces ?? []).map((w) => w.id)
  );

  reconciler.apply(connection, message);

  invalidateForUnknownWorkspaces(utils, projectId, [entry], knownWorkspaceIds, alreadyInvalidated);

  healReadyWorktreePaths(utils, projectId, [entry], knownWorkspaceIds, repairedWorktreePaths);

  mergeLiveWorkspaceDetail(utils, queryClient, entry, removedWorkspaceIds);
}

function applySnapshotRemovedMessage(
  queryClient: QueryClient,
  message: SnapshotRemovedMessage,
  pendingRequests: Map<string, PendingRequestType>,
  removedWorkspaceIds: Set<string>,
  reconciler: ProjectWorkspaceCacheReconciler,
  connection: WorkspaceConnection
): void {
  pendingRequests.delete(message.workspaceId);

  reconciler.apply(connection, message);

  resetRemovedWorkspaceDetail(queryClient, message.workspaceId, removedWorkspaceIds);
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Subscribes to the /snapshots WebSocket endpoint for a given project
 * and updates the React Query caches for `workspace.listForProject`
 * (sidebar and kanban board) and `workspace.get` (detail view) whenever
 * snapshot_full, snapshot_changed, or snapshot_removed messages arrive.
 *
 * Returns void -- the hook's side effect is updating the caches.
 */
export function useProjectSnapshotSync(projectId: string | undefined): void {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const previousPendingRequestsRef = useRef<Map<string, PendingRequestType>>(new Map());
  // A project's first snapshot_full arrives alongside its initial query
  // fetches, so it needs no refetch. Every later baseline for that project
  // follows a gap — a network reconnect or a switch away and back — during
  // which deltas were dropped, so it must also refetch-heal the
  // staleTime: Infinity workspace caches. Keyed per project because the hook
  // survives project switches.
  const baselineProjectsRef = useRef<Set<string>>(new Set());
  // Caps the unknown-workspace invalidation (see invalidateForUnknownWorkspaces)
  // at one refetch per workspace id, so a burst of snapshot messages for the
  // same newly-introduced workspace doesn't trigger a refetch storm.
  const invalidatedForUnknownWorkspaceRef = useRef<Set<string>>(new Set());
  const repairedWorktreePathsRef = useRef<Set<string>>(new Set());
  const removedWorkspaceIdsRef = useRef<Set<string>>(new Set());

  const lifecycle = useMemo(
    () => ({
      owner: projectId ? getProjectWorkspaceCacheReconciler(queryClient, projectId) : undefined,
      connection: undefined as WorkspaceConnection | undefined,
      opened: false,
      disposed: false,
    }),
    [queryClient, projectId]
  );
  const fallbackToHttp = useCallback(() => {
    if (!projectId) {
      return;
    }
    const filter = {
      queryKey: getQueryKey(trpc.workspace.listForProject, { projectId }, 'query'),
      exact: true,
    };
    const detailFilter = projectWorkspaceDetailQueryFilter(queryClient, projectId);
    runInBackground(queryClient.cancelQueries(detailFilter), 'Could not refresh data');
    runInBackground(queryClient.invalidateQueries(detailFilter), 'Could not refresh data');
    // Cancel synchronously before invalidating, including an uncached bootstrap
    // whose old connection result must not win over the fallback request.
    runInBackground(queryClient.cancelQueries(filter), 'Could not refresh data');
    runInBackground(
      utils.workspace.listForProject.invalidate({ projectId }),
      'Could not refresh data'
    );
  }, [projectId, queryClient, utils]);
  useEffect(() => {
    lifecycle.disposed = false;
    const previousEpoch = lifecycle.owner?.captureEpoch();
    lifecycle.connection = lifecycle.owner?.beginConnection();
    if (previousEpoch && lifecycle.connection?.identity !== previousEpoch) {
      fallbackToHttp();
    }
    return () => {
      lifecycle.disposed = true;
      if (lifecycle.connection && lifecycle.owner?.retireConnection(lifecycle.connection)) {
        fallbackToHttp();
      }
    };
  }, [lifecycle, fallbackToHttp]);
  const onConnected = useCallback(() => {
    if (lifecycle.disposed || !lifecycle.owner) {
      return;
    }
    const previous = lifecycle.connection;
    if (previous && lifecycle.owner.isCurrent(previous) && !lifecycle.opened) {
      lifecycle.opened = true;
      return;
    }
    if (previous) {
      lifecycle.owner.retireConnection(previous);
    }
    lifecycle.connection = lifecycle.owner.beginConnection();
    lifecycle.opened = true;
    // A reconnect begins a fresh epoch, so pending fallback HTTP must restart
    // after the new token exists rather than carrying the retired HTTP epoch.
    fallbackToHttp();
  }, [lifecycle, fallbackToHttp]);
  const onDisconnected = useCallback(() => {
    if (
      !lifecycle.disposed &&
      lifecycle.connection &&
      lifecycle.owner?.retireConnection(lifecycle.connection)
    ) {
      fallbackToHttp();
    }
  }, [lifecycle, fallbackToHttp]);
  const url = projectId ? buildWebSocketUrl('/snapshots', { projectId }) : null;

  const handleMessage = useCallback(
    (message: SnapshotServerMessage) => {
      const connection = lifecycle.connection;
      const reconciler = lifecycle.owner;
      if (
        !projectId ||
        lifecycle.disposed ||
        !connection ||
        !reconciler?.accepts(connection, message)
      ) {
        return;
      }
      switch (message.type) {
        case 'snapshot_full': {
          applySnapshotFullMessage(
            utils,
            queryClient,
            message,
            previousPendingRequestsRef.current,
            invalidatedForUnknownWorkspaceRef.current,
            repairedWorktreePathsRef.current,
            removedWorkspaceIdsRef.current,
            reconciler,
            connection
          );
          if (baselineProjectsRef.current.has(message.projectId)) {
            healWorkspaceCachesAfterReconnect(utils, message.projectId);
          } else {
            baselineProjectsRef.current.add(message.projectId);
          }
          break;
        }

        case 'snapshot_changed': {
          applySnapshotChangedMessage(
            utils,
            queryClient,
            projectId,
            message,
            previousPendingRequestsRef.current,
            invalidatedForUnknownWorkspaceRef.current,
            repairedWorktreePathsRef.current,
            removedWorkspaceIdsRef.current,
            reconciler,
            connection
          );
          break;
        }

        case 'snapshot_removed': {
          applySnapshotRemovedMessage(
            queryClient,
            message,
            previousPendingRequestsRef.current,
            removedWorkspaceIdsRef.current,
            reconciler,
            connection
          );
          break;
        }
      }
    },
    [projectId, queryClient, utils, lifecycle]
  );

  useWebSocketChannel({
    url,
    schema: SnapshotServerMessageSchema,
    onMessage: handleMessage,
    onConnected,
    onDisconnected,
    queuePolicy: 'drop',
  });
}
