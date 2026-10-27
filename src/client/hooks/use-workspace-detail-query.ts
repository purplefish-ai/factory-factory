import { useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/client/lib/trpc';
import { workspaceDetailQueryOptions } from '@/client/lib/workspace-cache-reconciler';

/** Route and right panel use the same detail hydration and stream authority. */
export function useWorkspaceDetailQuery(workspaceId: string) {
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  return useQuery({
    ...workspaceDetailQueryOptions(queryClient, workspaceId, (signal) =>
      utils.client.workspace.get.query({ id: workspaceId }, { signal })
    ),
    enabled: Boolean(workspaceId),
  });
}
