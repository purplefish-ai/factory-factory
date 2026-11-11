import type { QueryClient } from '@tanstack/react-query';
import { runInBackground } from '@/client/lib/background-task';
import {
  cancelWorkspaceDetail,
  getCachedWorkspaceDetails,
  mergeWorkspaceDetailSnapshot,
  refetchActiveWorkspaceDetail,
  resetWorkspaceDetail,
} from '@/client/lib/workspace-queries';
import type { WorkspaceSnapshotEntry } from '@/shared/workspace-snapshot';

export interface ProjectWorkspaceDetailTransitions {
  resetDepartures(
    entries: readonly WorkspaceSnapshotEntry[],
    previousWorkspaceIds: ReadonlySet<string>
  ): void;
  mergeLive(entry: WorkspaceSnapshotEntry): void;
  remove(workspaceId: string): void;
}

export interface WorkspaceDetailTransitionScope {
  forProject(queryClient: QueryClient, projectId: string): ProjectWorkspaceDetailTransitions;
}

/** One hook mount owns departure history, including across activation changes. */
export function createWorkspaceDetailTransitionScope(): WorkspaceDetailTransitionScope {
  const removedWorkspaceIds = new Set<string>();
  return {
    forProject(queryClient, projectId) {
      /** Reset existing detail observers once per departure from the live list. */
      const remove = (workspaceId: string): void => {
        if (removedWorkspaceIds.has(workspaceId)) {
          return;
        }
        removedWorkspaceIds.add(workspaceId);
        // Reset clears old data and synchronously cancels its request before
        // active observers refetch persisted detail. No initialData is configured.
        runInBackground(resetWorkspaceDetail(queryClient, workspaceId));
      };
      return {
        remove,
        resetDepartures(entries, previousWorkspaceIds) {
          const liveWorkspaceIds = new Set(entries.map((entry) => entry.workspaceId));
          const removalCandidates = new Set(previousWorkspaceIds);
          // A detail can outlive an empty/evicted project list across navigation.
          for (const detail of getCachedWorkspaceDetails(queryClient)) {
            if (
              detail?.projectId === projectId &&
              detail.status !== 'ARCHIVING' &&
              detail.status !== 'ARCHIVED'
            ) {
              removalCandidates.add(detail.id);
            }
          }
          for (const workspaceId of removalCandidates) {
            if (!liveWorkspaceIds.has(workspaceId)) {
              remove(workspaceId);
            }
          }
        },
        mergeLive(entry) {
          const reintroduced = removedWorkspaceIds.delete(entry.workspaceId);
          if (reintroduced) {
            // Cancellation takes effect synchronously; do not await before merging.
            runInBackground(cancelWorkspaceDetail(queryClient, entry.workspaceId));
          }
          mergeWorkspaceDetailSnapshot(queryClient, entry);
          if (reintroduced) {
            // Reset may have cleared full detail, which a summary cannot recreate.
            runInBackground(refetchActiveWorkspaceDetail(queryClient, entry.workspaceId));
          }
        },
      };
    },
  };
}
