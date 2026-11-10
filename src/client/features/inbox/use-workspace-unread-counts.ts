import { POLL_INTERVAL_MS } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import type { WorkspaceUnreadMailCounts } from '@/shared/workspace-mail';

/** One shared project query, not one mail-list request per workspace row. */
export function useWorkspaceUnreadCounts(projectId: string | undefined): {
  data: WorkspaceUnreadMailCounts | undefined;
} {
  const query = trpc.workspace.unreadMailCounts.useQuery(
    { projectId: projectId ?? '' },
    {
      enabled: Boolean(projectId),
      staleTime: 5000,
      refetchInterval: POLL_INTERVAL_MS.workspaceContext,
    }
  );
  return { data: query.data };
}
