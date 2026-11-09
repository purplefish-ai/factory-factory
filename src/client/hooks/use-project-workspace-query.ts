import { useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/client/lib/trpc';
import { projectWorkspaceListQuery } from '@/client/lib/workspace-queries';

/** Board, sidebar, switcher and forms share the existing tRPC query key and writer. */
export function useProjectWorkspaceQuery(projectId: string | undefined) {
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  return useQuery({
    ...projectWorkspaceListQuery(queryClient, utils.client, projectId ?? ''),
    enabled: Boolean(projectId),
  });
}
