import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import {
  getLiveWorkspaceSnapshot,
  subscribeLiveWorkspaceSnapshots,
} from '@/client/lib/workspace-queries';
import type { WorkspaceSnapshotEntry } from '@/shared/workspace-snapshot';

/**
 * One field of a workspace's `/snapshots` entry while the stream carries it,
 * or `undefined` while it does not (socket down, before the baseline, another
 * project selected, workspace archived). Readers use `undefined` to fall back
 * to polling. `select` must return a primitive or a stable reference, since
 * every message for the project re-reads it.
 */
export function useLiveWorkspaceSnapshot<T>(
  workspaceId: string,
  select: (entry: WorkspaceSnapshotEntry) => T
): T | undefined {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (listener: () => void) => subscribeLiveWorkspaceSnapshots(queryClient, listener),
    [queryClient]
  );
  const read = () => {
    const entry = getLiveWorkspaceSnapshot(queryClient, workspaceId);
    return entry ? select(entry) : undefined;
  };
  return useSyncExternalStore(subscribe, read, read);
}
