import { useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/client/lib/trpc';
import { workspaceDetailQuery } from '@/client/lib/workspace-queries';

/** Observer-only settings; cache options and the commit hook stay with workspace-queries. */
export interface WorkspaceDetailQuerySettings {
  enabled?: boolean;
  refetchInterval?: number;
  staleTime?: number;
}

/** Route, right panel and family menu share the same detail hydration and stream authority. */
export function useWorkspaceDetailQuery(
  workspaceId: string,
  { enabled = true, ...settings }: WorkspaceDetailQuerySettings = {}
) {
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  return useQuery({
    ...workspaceDetailQuery(queryClient, utils.client, workspaceId),
    ...settings,
    enabled: enabled && Boolean(workspaceId),
  });
}
