import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { generateUniqueWorkspaceName } from '@/shared/workspace-words';
import { trpc } from '../lib/trpc';

/**
 * Shared hook for creating workspaces with consistent behavior across the app.
 * Handles unique name generation, loading state, error handling, and navigation.
 *
 * When `externalNames` is provided the hook skips its own `workspace.list` query
 * and uses the supplied names for unique-name generation instead. This avoids a
 * redundant fetch when the caller (e.g. the sidebar) already has workspace data.
 */
export function useCreateWorkspace(
  projectId: string | undefined,
  projectSlug: string,
  externalNames?: string[]
) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [isCreating, setIsCreating] = useState(false);
  const createWorkspace = trpc.workspace.create.useMutation();

  // Only fetch workspace names when the caller hasn't provided them
  const { data: allWorkspaces } = trpc.workspace.list.useQuery(
    { projectId: projectId ?? '' },
    { enabled: !!projectId && externalNames === undefined }
  );
  const existingNames = externalNames ?? allWorkspaces?.map((w) => w.name) ?? [];

  const handleCreate = async (nameOverride?: string) => {
    if (!projectId || isCreating) {
      return;
    }
    const name = nameOverride ?? generateUniqueWorkspaceName(existingNames);
    setIsCreating(true);

    try {
      const workspace = await createWorkspace.mutateAsync({
        type: 'MANUAL',
        projectId,
        name,
      });

      // Optimistically populate the workspace detail query cache so the status
      // is immediately visible when navigating to the detail page
      utils.workspace.get.setData({ id: workspace.id }, (old) => {
        // If there's already data (shouldn't happen for a new workspace), keep it
        if (old) {
          return old;
        }

        // Set minimal workspace data with computed fields matching workspace.get endpoint
        return {
          ...workspace,
          claudeSessions: [],
          terminalSessions: [],
          sidebarStatus: {
            activityState: 'IDLE' as const,
            ciState: 'NONE' as const,
          },
          ratchetButtonAnimated: false,
          flowPhase: 'NO_PR' as const,
          ciObservation: 'NOT_FETCHED' as const,
        };
      });

      utils.workspace.list.invalidate({ projectId });
      utils.workspace.getProjectSummaryState.invalidate({ projectId });
      setIsCreating(false);
      navigate(`/projects/${projectSlug}/workspaces/${workspace.id}`);
    } catch (error) {
      setIsCreating(false);
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Failed to create workspace: ${message}`);
      throw error;
    }
  };

  return { handleCreate, isCreating, existingNames };
}
