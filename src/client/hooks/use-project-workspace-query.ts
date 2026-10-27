import { useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/client/lib/trpc';
import { projectWorkspaceQueryOptions } from '@/client/lib/workspace-cache-reconciler';

/** Board, sidebar and switcher share the existing tRPC query key and writer. */
export function useProjectWorkspaceQuery(projectId: string | undefined) {
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  return useQuery({
    ...projectWorkspaceQueryOptions(queryClient, projectId ?? '', (signal) =>
      utils.client.workspace.listForProject.query({ projectId: projectId ?? '' }, { signal })
    ),
    enabled: Boolean(projectId),
  });
}
