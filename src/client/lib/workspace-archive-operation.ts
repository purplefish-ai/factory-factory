import type { QueryClient } from '@tanstack/react-query';
import { getProjectWorkspaceCacheReconciler } from '@/client/lib/workspace-cache-reconciler';

/** Captures project identity before any asynchronous mutation or route change. */
export function beginWorkspaceArchiveOperation(
  client: QueryClient,
  projectId: string,
  ids: readonly string[]
) {
  const owner = getProjectWorkspaceCacheReconciler(client, projectId);
  const operation = owner.beginArchive(ids);
  return {
    settle: (failedIds: readonly string[], successfulIds: readonly string[] = []) =>
      owner.settleArchive(operation, failedIds, successfulIds),
  };
}
