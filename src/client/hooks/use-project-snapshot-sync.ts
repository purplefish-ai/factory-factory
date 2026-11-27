import { type QueryClient, useQueryClient } from '@tanstack/react-query';
/**
 * React hook that syncs /snapshots WebSocket messages into the
 * workspace.listForProject (sidebar + kanban) and workspace.get (detail
 * header/session runtime) React Query cache entries.
 *
 * Merge strategy — one strategy per cache per message:
 * - Ordinary snapshot_changed / snapshot_removed deltas patch caches directly.
 *   Legacy ready workspaces missing a cached worktree path refetch the project
 *   list once; complete summaries already carry the authoritative nullable path.
 * - snapshot_full is the (re)connect baseline. Any baseline after a
 *   project's first follows a gap (network reconnect, or a switch away and
 *   back) during which deltas were dropped. It makes complete list rows
 *   current, so those baselines refetch the list only for legacy entries, and
 *   refetch detail, which carries database fields no entry has.
 * - A dropped connection waits for the next baseline rather than reading
 *   everything over HTTP at once; the HTTP fallback runs when the reconnect
 *   attempt fails or the server reports snapshot_error.
 *
 * Follows the use-log-stream.ts pattern: receive-only WebSocket hook with
 * drop queue policy (no outbound messages, reconnect discards stale data).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { runInBackground } from '@/client/lib/background-task';
import { isCompleteWorkspaceSnapshot } from '@/client/lib/snapshot-to-workspace';
import { trpc } from '@/client/lib/trpc';
import {
  getProjectWorkspaceCacheReconciler,
  projectWorkspaceDetailQueryFilter,
  type ProjectWorkspaceCacheReconciler,
  type WorkspaceConnection,
} from '@/client/lib/workspace-cache-reconciler';
import {
  createWorkspaceDetailTransitionScope,
  type ProjectWorkspaceDetailTransitions,
} from '@/client/lib/workspace-detail-snapshot-transitions';
import {
  cancelProjectWorkspaceList,
  restartPendingProjectWorkspaceReads,
} from '@/client/lib/workspace-queries';
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
 * Heals the workspace caches after any snapshot_full baseline past a project's
 * first, which follows a gap whose deltas were dropped.
 *
 * Detail carries database fields no snapshot entry has (description, sessions,
 * init and run-script state, the initial prompt), so this project's owned
 * detail, including deliberately opened archived workspaces, is refetched where
 * mounted and marked stale elsewhere. A complete entry carries every list field,
 * so the baseline has already made those rows and the membership current; the
 * list is refetched only for legacy entries. (A missing review count is no
 * reason: the list reads the same server cache and reports 0 for it.) Both join
 * a read already in flight, which began under this connection.
 */
function healWorkspaceCachesAfterReconnect(
  utils: TrpcUtils,
  queryClient: QueryClient,
  message: SnapshotFullMessage
): void {
  const { projectId } = message;
  runInBackground(
    queryClient.invalidateQueries(projectWorkspaceDetailQueryFilter(queryClient, projectId), {
      cancelRefetch: false,
    })
  );
  if (!message.entries.every((entry) => isCompleteWorkspaceSnapshot(entry))) {
    runInBackground(
      utils.workspace.listForProject.invalidate({ projectId }, undefined, { cancelRefetch: false })
    );
  }
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
 * Refetches the project list for legacy rows whose metadata only HTTP supplies,
 * then releases the rows `unrepaired` still reports so a later message can
 * retry them.
 *
 * The refetch joins a list request already in flight rather than cancelling it.
 * On page open the first snapshot often lands while the board's own read is
 * pending, and that read already carries these rows; cancelling it downloaded
 * the list twice. A joined read can predate a row (a workspace created or made
 * ready after it was read), so rows it did not repair get one fresh read.
 */
function repairProjectListMetadata(
  utils: TrpcUtils,
  projectId: string,
  entries: readonly WorkspaceSnapshotEntry[],
  unrepaired: (entries: readonly WorkspaceSnapshotEntry[]) => WorkspaceSnapshotEntry[],
  release: (entries: readonly WorkspaceSnapshotEntry[]) => void
): void {
  // A failed read rejects, releasing the rows for a later message instead of
  // retrying the read straight away.
  const refetch = () =>
    utils.workspace.listForProject.invalidate({ projectId }, undefined, {
      cancelRefetch: false,
      throwOnError: true,
    });
  void refetch().then(
    () => {
      const missed = unrepaired(entries);
      if (missed.length) {
        void refetch().then(
          () => release(unrepaired(missed)),
          () => release(missed)
        );
      }
    },
    () => release(entries)
  );
}

/**
 * Legacy snapshot entries carry only live fields. Mutation-sourced fields —
 * including `githubIssueNumber` and `linearIssueId`, which the Todo column
 * matches issues against — fall back to nulls for a workspace no fetch has
 * returned yet, so the workspace lands on the board while its issue is still
 * in Todo. Invalidating once at the point of introduction repairs every such
 * field rather than the two that happen to hurt. `alreadyInvalidated` caps it
 * at one repair per previously-unseen workspace id, so a burst of snapshot
 * messages for the same new workspace doesn't trigger a refetch storm.
 */
function invalidateForUnknownWorkspaces(
  utils: TrpcUtils,
  reconciler: ProjectWorkspaceCacheReconciler,
  projectId: string,
  entriesToCheck: WorkspaceSnapshotEntry[],
  knownWorkspaceIds: Set<string>,
  alreadyInvalidated: Set<string>
): void {
  const introduced = entriesToCheck.filter(
    (entry) =>
      !(
        alreadyInvalidated.has(entry.workspaceId) ||
        knownWorkspaceIds.has(entry.workspaceId) ||
        isCompleteWorkspaceSnapshot(entry)
      )
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

  // Releasing the marks when the repair fails is what keeps the guard from
  // turning a transient error into permanent staleness. Without it, these
  // workspaces stay marked as repaired forever, so their issue-link fields stay
  // null and their issues sit in Todo alongside the board card until something
  // else forces a refetch.
  repairProjectListMetadata(
    utils,
    projectId,
    introduced,
    (entries) => entries.filter((entry) => !reconciler.hasHttpMetadata(entry.workspaceId)),
    (entries) => {
      for (const entry of entries) {
        alreadyInvalidated.delete(entry.workspaceId);
      }
    }
  );
}

/** Legacy snapshots omit the worktree path required for PR review. */
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
      !repairedWorkspaceIds.has(entry.workspaceId) &&
      !cachedById.get(entry.workspaceId)?.worktreePath &&
      !isCompleteWorkspaceSnapshot(entry)
  );
  if (!missingPaths.length) {
    return;
  }
  for (const entry of missingPaths) {
    repairedWorkspaceIds.add(entry.workspaceId);
  }
  repairProjectListMetadata(
    utils,
    projectId,
    missingPaths,
    (pending) => {
      const refreshedById = new Map(
        utils.workspace.listForProject
          .getData({ projectId })
          ?.workspaces.map((workspace) => [workspace.id, workspace])
      );
      return pending.filter((entry) => !refreshedById.get(entry.workspaceId)?.worktreePath);
    },
    (pending) => {
      for (const entry of pending) {
        repairedWorkspaceIds.delete(entry.workspaceId);
      }
    }
  );
}

function applySnapshotFullMessage(
  utils: TrpcUtils,
  details: ProjectWorkspaceDetailTransitions,
  message: SnapshotFullMessage,
  pendingRequests: Map<string, PendingRequestType>,
  alreadyInvalidated: Set<string>,
  repairedWorktreePaths: Set<string>,
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

  details.resetDepartures(entries, knownWorkspaceIds);
  reconciler.apply(connection, message);

  invalidateForUnknownWorkspaces(
    utils,
    reconciler,
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
    details.mergeLive(entry);
  }
}

function applySnapshotChangedMessage(
  utils: TrpcUtils,
  details: ProjectWorkspaceDetailTransitions,
  projectId: string,
  message: SnapshotChangedMessage,
  pendingRequests: Map<string, PendingRequestType>,
  alreadyInvalidated: Set<string>,
  repairedWorktreePaths: Set<string>,
  reconciler: ProjectWorkspaceCacheReconciler,
  connection: WorkspaceConnection
): void {
  const entry = message.entry;

  maybeTriggerPendingRequestAttention(pendingRequests, entry);

  const knownWorkspaceIds = new Set(
    (utils.workspace.listForProject.getData({ projectId })?.workspaces ?? []).map((w) => w.id)
  );

  reconciler.apply(connection, message);

  invalidateForUnknownWorkspaces(
    utils,
    reconciler,
    projectId,
    [entry],
    knownWorkspaceIds,
    alreadyInvalidated
  );

  healReadyWorktreePaths(utils, projectId, [entry], knownWorkspaceIds, repairedWorktreePaths);

  details.mergeLive(entry);
}

function applySnapshotRemovedMessage(
  details: ProjectWorkspaceDetailTransitions,
  message: SnapshotRemovedMessage,
  pendingRequests: Map<string, PendingRequestType>,
  reconciler: ProjectWorkspaceCacheReconciler,
  connection: WorkspaceConnection
): void {
  pendingRequests.delete(message.workspaceId);

  reconciler.apply(connection, message);

  details.remove(message.workspaceId);
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
  const detailTransitionsRef = useRef(createWorkspaceDetailTransitionScope());

  const lifecycle = useMemo(
    () => ({
      owner: projectId ? getProjectWorkspaceCacheReconciler(queryClient, projectId) : undefined,
      details: projectId
        ? detailTransitionsRef.current.forProject(queryClient, projectId)
        : undefined,
      connection: undefined as WorkspaceConnection | undefined,
      opened: false,
      disposed: false,
      // A connection dropped and no baseline has arrived since.
      awaitingBaseline: false,
      // The HTTP fallback already ran during this gap.
      fellBack: false,
    }),
    [queryClient, projectId]
  );
  const fallbackToHttp = useCallback(() => {
    if (!projectId) {
      return;
    }
    const detailFilter = projectWorkspaceDetailQueryFilter(queryClient, projectId);
    runInBackground(queryClient.cancelQueries(detailFilter));
    runInBackground(queryClient.invalidateQueries(detailFilter));
    // Cancel synchronously before invalidating, including an uncached bootstrap
    // whose old connection result must not win over the fallback request.
    runInBackground(cancelProjectWorkspaceList(queryClient, projectId));
    runInBackground(utils.workspace.listForProject.invalidate({ projectId }));
  }, [projectId, queryClient, utils]);
  // Reads begun under the retired connection can no longer commit, and empty
  // caches need data before the next baseline; cached data waits for it.
  const restartPendingHttp = useCallback(() => {
    if (projectId) {
      runInBackground(restartPendingProjectWorkspaceReads(queryClient, projectId));
    }
  }, [projectId, queryClient]);
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
    // A reconnect begins a fresh epoch, so pending HTTP must restart after the
    // new token exists rather than carrying the retired epoch. Cached data is
    // left for this connection's baseline.
    restartPendingHttp();
  }, [lifecycle, restartPendingHttp]);
  const onDisconnected = useCallback(() => {
    if (lifecycle.disposed) {
      return;
    }
    const retired = Boolean(
      lifecycle.connection && lifecycle.owner?.retireConnection(lifecycle.connection)
    );
    if (lifecycle.awaitingBaseline && !lifecycle.fellBack) {
      // The reconnect attempt failed: the stream is down, so HTTP brings the
      // caches up to date once for this gap.
      lifecycle.fellBack = true;
      fallbackToHttp();
    } else if (retired) {
      // Usually the transport reconnects within a second or two and the next
      // baseline heals the gap, so only reads the old connection began restart.
      lifecycle.awaitingBaseline = true;
      restartPendingHttp();
    }
  }, [lifecycle, fallbackToHttp, restartPendingHttp]);
  const url = projectId ? buildWebSocketUrl('/snapshots', { projectId }) : null;

  const handleMessage = useCallback(
    (message: SnapshotServerMessage) => {
      const connection = lifecycle.connection;
      const reconciler = lifecycle.owner;
      if (
        !projectId ||
        lifecycle.disposed ||
        !connection ||
        !reconciler?.accepts(connection, message) ||
        !lifecycle.details
      ) {
        return;
      }
      if (message.type === 'snapshot_error') {
        toast.error(message.message);
        fallbackToHttp();
        return;
      }
      switch (message.type) {
        case 'snapshot_full': {
          applySnapshotFullMessage(
            utils,
            lifecycle.details,
            message,
            previousPendingRequestsRef.current,
            invalidatedForUnknownWorkspaceRef.current,
            repairedWorktreePathsRef.current,
            reconciler,
            connection
          );
          lifecycle.awaitingBaseline = false;
          lifecycle.fellBack = false;
          if (baselineProjectsRef.current.has(message.projectId)) {
            healWorkspaceCachesAfterReconnect(utils, queryClient, message);
          } else {
            baselineProjectsRef.current.add(message.projectId);
          }
          break;
        }

        case 'snapshot_changed': {
          applySnapshotChangedMessage(
            utils,
            lifecycle.details,
            projectId,
            message,
            previousPendingRequestsRef.current,
            invalidatedForUnknownWorkspaceRef.current,
            repairedWorktreePathsRef.current,
            reconciler,
            connection
          );
          break;
        }

        case 'snapshot_removed': {
          applySnapshotRemovedMessage(
            lifecycle.details,
            message,
            previousPendingRequestsRef.current,
            reconciler,
            connection
          );
          break;
        }
      }
    },
    [projectId, queryClient, utils, lifecycle, fallbackToHttp]
  );

  useWebSocketChannel({
    url,
    schema: SnapshotServerMessageSchema,
    onMessage: handleMessage,
    onConnected,
    onDisconnected,
    queuePolicy: 'drop',
    announceConnectionLoss: true,
  });
}
