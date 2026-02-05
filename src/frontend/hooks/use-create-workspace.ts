import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { generateUniqueWorkspaceName } from '@/shared/workspace-words';
import { trpc } from '../lib/trpc';

/**
 * Shared hook for creating workspaces with consistent behavior across the app.
 * Handles unique name generation, loading state, error handling, and navigation.
 */
export function useCreateWorkspace(projectId: string | undefined, projectSlug: string) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [isCreating, setIsCreating] = useState(false);
  const createWorkspace = trpc.workspace.create.useMutation();

  // Get existing workspace names for unique name generation
  const { data: allWorkspaces } = trpc.workspace.list.useQuery(
    { projectId: projectId ?? '' },
    { enabled: !!projectId }
  );
  const existingNames = allWorkspaces?.map((w) => w.name) ?? [];

  const handleCreate = async (nameOverride?: string) => {
    if (!projectId || isCreating) {
      return;
    }
    const name = nameOverride ?? generateUniqueWorkspaceName(existingNames);
    setIsCreating(true);

    try {
      const workspace = await createWorkspace.mutateAsync({
        projectId,
        name,
      });

      utils.workspace.list.invalidate({ projectId });
      utils.workspace.getProjectSummaryState.invalidate({ projectId });
      setIsCreating(false);
      navigate(`/projects/${projectSlug}/workspaces/${workspace.id}`);
    } catch (error) {
      setIsCreating(false);
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Failed to create workspace: ${message}`);
    }
  };

  return { handleCreate, isCreating, existingNames };
}
