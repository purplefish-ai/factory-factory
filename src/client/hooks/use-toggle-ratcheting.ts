/**
 * Shared optimistic mutation for workspace.toggleRatcheting.
 *
 * Single toggle path for both the workspace header and the kanban board:
 * optimistically patches the three workspace caches, registers the in-flight
 * value so snapshot merges can't flip it back (see
 * overridePendingRatchetToggle), and reconciles with the server on settle.
 */

import {
  applyRatchetToggleState,
  clearPendingRatchetToggle,
  setPendingRatchetToggle,
  updateWorkspaceRatchetState,
} from '@/client/lib/ratchet-toggle-cache';
import { trpc } from '@/client/lib/trpc';

export interface ToggleRatchetingInput {
  workspaceId: string;
  enabled: boolean;
}

/** Explicit return type to avoid TypeScript portability issues with internal tRPC types */
export interface UseToggleRatchetingReturn {
  mutate: (input: ToggleRatchetingInput) => void;
  mutateAsync: (input: ToggleRatchetingInput) => Promise<unknown>;
  isPending: boolean;
}

export function useToggleRatcheting(projectId: string): UseToggleRatchetingReturn {
  const utils = trpc.useUtils();

  return trpc.workspace.toggleRatcheting.useMutation({
    onMutate: ({ workspaceId, enabled }) => {
      setPendingRatchetToggle(workspaceId, enabled);

      utils.workspace.get.setData({ id: workspaceId }, (old) => {
        if (!old) {
          return old;
        }
        return applyRatchetToggleState(old, enabled);
      });
      utils.workspace.listWithKanbanState.setData({ projectId }, (old) => {
        if (!old) {
          return old;
        }
        return updateWorkspaceRatchetState(old, workspaceId, enabled);
      });
      utils.workspace.getProjectSummaryState.setData({ projectId }, (old) => {
        if (!old) {
          return old;
        }
        return {
          ...old,
          workspaces: updateWorkspaceRatchetState(old.workspaces, workspaceId, enabled),
        };
      });
    },
    onSettled: (_data, _error, { workspaceId }) => {
      clearPendingRatchetToggle(workspaceId);
      utils.workspace.get.invalidate({ id: workspaceId });
      utils.workspace.listWithKanbanState.invalidate({ projectId });
      utils.workspace.getProjectSummaryState.invalidate({ projectId });
    },
  });
}
