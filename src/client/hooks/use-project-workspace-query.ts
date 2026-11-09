import { useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/client/lib/trpc';
import { projectWorkspaceListQuery } from '@/client/lib/workspace-queries';

/** Observer-only settings; cache options and the commit hook stay with workspace-queries. */
export interface ProjectWorkspaceQuerySettings {
  staleTime?: number;
}

/** Board, sidebar, switcher and forms share the existing tRPC query key and writer. */
export function useProjectWorkspaceQuery(
  projectId: string | undefined,
  settings: ProjectWorkspaceQuerySettings = {}
) {
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  return useQuery({
    ...projectWorkspaceListQuery(queryClient, utils.client, projectId ?? ''),
    ...settings,
    enabled: Boolean(projectId),
  });
}
