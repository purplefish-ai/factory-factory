/**
 * React hook that syncs /snapshots WebSocket messages into the
 * workspace.listForProject (sidebar + kanban) and workspace.get (detail
 * header/session runtime) React Query cache entries.
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
  projectSnapshotToWorkspace,
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
type ProjectWorkspaceCache = RouterOutputs['workspace']['listForProject'];
type ProjectWorkspace = ProjectWorkspaceCache['workspaces'][number];
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
  utils.workspace.get.invalidate();
  utils.workspace.listForProject.invalidate({ projectId });
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

/** Upsert one entry into the project list, preserving its position. */
function upsertProjectWorkspace(
  workspaces: ProjectWorkspace[],
  entry: WorkspaceSnapshotEntry
): ProjectWorkspace[] {
  const existingIndex = workspaces.findIndex((workspace) => workspace.id === entry.workspaceId);
  const mapped = projectSnapshotToWorkspace(entry, workspaces[existingIndex]);

  if (existingIndex < 0) {
    return [...workspaces, mapped];
  }

  const next = [...workspaces];
  next[existingIndex] = mapped;
  return next;
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
  if (introduced.length > 0) {
    for (const entry of introduced) {
      alreadyInvalidated.add(entry.workspaceId);
    }
    void utils.workspace.listForProject.invalidate({ projectId });
  }
}

function applySnapshotFullMessage(
  utils: TrpcUtils,
  message: SnapshotFullMessage,
  pendingRequests: Map<string, PendingRequestType>,
  alreadyInvalidated: Set<string>
): void {
  const entries = message.entries.map(overridePendingRatchetToggle);

  seedPendingRequests(pendingRequests, entries);

  const knownWorkspaceIds = new Set(
    (
      utils.workspace.listForProject.getData({ projectId: message.projectId })?.workspaces ?? []
    ).map((w) => w.id)
  );

  utils.workspace.listForProject.setData({ projectId: message.projectId }, (prev) => {
    const existingById = new Map(prev?.workspaces.map((workspace) => [workspace.id, workspace]));
    return {
      workspaces: entries.map((entry) =>
        projectSnapshotToWorkspace(entry, existingById.get(entry.workspaceId))
      ),
      reviewCount: message.reviewCount ?? prev?.reviewCount ?? 0,
    };
  });

  invalidateForUnknownWorkspaces(
    utils,
    message.projectId,
    entries,
    knownWorkspaceIds,
    alreadyInvalidated
  );

  for (const entry of entries) {
    utils.workspace.get.setData({ id: entry.workspaceId }, (prev) =>
      mergeProjectSnapshotIntoWorkspaceDetail(entry, prev)
    );
  }
}

function applySnapshotChangedMessage(
  utils: TrpcUtils,
  projectId: string,
  message: SnapshotChangedMessage,
  pendingRequests: Map<string, PendingRequestType>,
  alreadyInvalidated: Set<string>
): void {
  const entry = overridePendingRatchetToggle(message.entry);

  maybeTriggerPendingRequestAttention(pendingRequests, entry);

  const knownWorkspaceIds = new Set(
    (utils.workspace.listForProject.getData({ projectId })?.workspaces ?? []).map((w) => w.id)
  );

  utils.workspace.listForProject.setData({ projectId }, (prev) => {
    if (!prev) {
      return {
        workspaces: [projectSnapshotToWorkspace(entry)],
        reviewCount: message.reviewCount ?? 0,
      };
    }

    return {
      workspaces: upsertProjectWorkspace(prev.workspaces, entry),
      reviewCount: message.reviewCount ?? prev.reviewCount,
    };
  });

  invalidateForUnknownWorkspaces(utils, projectId, [entry], knownWorkspaceIds, alreadyInvalidated);

  utils.workspace.get.setData({ id: entry.workspaceId }, (prev) =>
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

  utils.workspace.listForProject.setData({ projectId }, (prev) => {
    if (!prev) {
      return prev;
    }
    return {
      workspaces: prev.workspaces.filter((workspace) => workspace.id !== message.workspaceId),
      reviewCount: message.reviewCount ?? prev.reviewCount,
    };
  });

  utils.workspace.get.setData({ id: message.workspaceId }, undefined);
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

  const url = projectId ? buildWebSocketUrl('/snapshots', { projectId }) : null;

  const handleMessage = useCallback(
    (message: SnapshotServerMessage) => {
      switch (message.type) {
        case 'snapshot_full': {
          applySnapshotFullMessage(
            utils,
            message,
            previousPendingRequestsRef.current,
            invalidatedForUnknownWorkspaceRef.current
          );
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
            previousPendingRequestsRef.current,
            invalidatedForUnknownWorkspaceRef.current
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
