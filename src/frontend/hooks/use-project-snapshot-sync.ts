/**
 * React hook that syncs /snapshots WebSocket messages into the
 * getProjectSummaryState React Query cache entry.
 *
 * Follows the use-dev-logs.ts pattern: receive-only WebSocket hook with
 * drop queue policy (no outbound messages, reconnect discards stale data).
 */

import { useCallback } from 'react';
import {
  mapSnapshotEntryToServerWorkspace,
  type SnapshotServerMessage,
} from '@/frontend/lib/snapshot-to-sidebar';
import { trpc } from '@/frontend/lib/trpc';
import { useWebSocketTransport } from '@/hooks/use-websocket-transport';
import { buildWebSocketUrl } from '@/lib/websocket-config';

// Type alias for the cache data shape (matches tRPC-inferred getProjectSummaryState output).
// We use a local type so the updater callbacks can be properly typed without
// running into ServerWorkspace's `createdAt: string | Date` vs the tRPC-inferred `Date`.
type CacheData = {
  workspaces: Record<string, unknown>[];
  reviewCount: number;
};

/**
 * Subscribes to the /snapshots WebSocket endpoint for a given project
 * and updates the React Query cache for `workspace.getProjectSummaryState`
 * whenever snapshot_full, snapshot_changed, or snapshot_removed messages
 * arrive.
 *
 * Returns void -- the hook's side effect is updating the cache.
 */
export function useProjectSnapshotSync(projectId: string | undefined): void {
  const utils = trpc.useUtils();

  const url = projectId ? buildWebSocketUrl('/snapshots', { projectId }) : null;

  const handleMessage = useCallback(
    (data: unknown) => {
      const message = data as SnapshotServerMessage;
      // Use the raw setData with type assertions to bypass strict tRPC generic
      // inference. The mapped ServerWorkspace shape (with createdAt as Date) is
      // functionally identical to the tRPC-inferred shape, but TypeScript cannot
      // prove this because ServerWorkspace declares createdAt as `string | Date`.
      const { setData } = utils.workspace.getProjectSummaryState;

      switch (message.type) {
        case 'snapshot_full': {
          setData({ projectId: message.projectId }, ((prev: CacheData | undefined) => ({
            workspaces: message.entries.map(mapSnapshotEntryToServerWorkspace),
            reviewCount: prev?.reviewCount ?? 0,
          })) as never);
          break;
        }

        case 'snapshot_changed': {
          if (!projectId) {
            break;
          }
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
          break;
        }

        case 'snapshot_removed': {
          if (!projectId) {
            break;
          }
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
