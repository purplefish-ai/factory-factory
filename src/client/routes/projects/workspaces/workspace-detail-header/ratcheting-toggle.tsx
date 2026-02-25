import { Loader2, Zap } from 'lucide-react';
import {
  applyRatchetToggleState,
  updateWorkspaceRatchetState,
} from '@/client/lib/ratchet-toggle-cache';
import { trpc } from '@/client/lib/trpc';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { RatchetToggleButton } from '@/components/workspace';
import type { WorkspaceHeaderWorkspace } from './types';

export function RatchetingToggle({
  workspace,
  workspaceId,
  renderAsMenuItem = false,
}: {
  workspace: WorkspaceHeaderWorkspace;
  workspaceId: string;
  renderAsMenuItem?: boolean;
}) {
  const utils = trpc.useUtils();

  const toggleRatcheting = trpc.workspace.toggleRatcheting.useMutation({
    onMutate: ({ enabled }) => {
      utils.workspace.get.setData({ id: workspaceId }, (old) => {
        if (!old) {
          return old;
        }
        return applyRatchetToggleState(old, enabled);
      });
      utils.workspace.listWithKanbanState.setData({ projectId: workspace.projectId }, (old) => {
        if (!old) {
          return old;
        }
        return updateWorkspaceRatchetState(old, workspaceId, enabled);
      });
      utils.workspace.getProjectSummaryState.setData({ projectId: workspace.projectId }, (old) => {
        if (!old) {
          return old;
        }
        return {
          ...old,
          workspaces: updateWorkspaceRatchetState(old.workspaces, workspaceId, enabled),
        };
      });
    },
    onError: () => {
      utils.workspace.get.invalidate({ id: workspaceId });
      utils.workspace.listWithKanbanState.invalidate({ projectId: workspace.projectId });
      utils.workspace.getProjectSummaryState.invalidate({ projectId: workspace.projectId });
    },
    onSuccess: () => {
      utils.workspace.get.invalidate({ id: workspaceId });
      utils.workspace.listWithKanbanState.invalidate({ projectId: workspace.projectId });
      utils.workspace.getProjectSummaryState.invalidate({ projectId: workspace.projectId });
    },
  });

  const workspaceRatchetEnabled = workspace.ratchetEnabled ?? true;

  if (renderAsMenuItem) {
    return (
      <DropdownMenuItem
        onSelect={() => {
          toggleRatcheting.mutate({ workspaceId, enabled: !workspaceRatchetEnabled });
        }}
        disabled={toggleRatcheting.isPending}
      >
        {toggleRatcheting.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Zap className="h-4 w-4" />
        )}
        {workspaceRatchetEnabled ? 'Turn off Ratchet' : 'Turn on Ratchet'}
      </DropdownMenuItem>
    );
  }

  return (
    <RatchetToggleButton
      enabled={workspaceRatchetEnabled}
      state={workspace.ratchetState}
      animated={workspace.ratchetButtonAnimated ?? false}
      disabled={toggleRatcheting.isPending}
      onToggle={(enabled) => {
        toggleRatcheting.mutate({ workspaceId, enabled });
      }}
    />
  );
}
