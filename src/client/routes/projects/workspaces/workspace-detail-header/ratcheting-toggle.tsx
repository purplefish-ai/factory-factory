import { LightningIcon, SpinnerGapIcon } from '@phosphor-icons/react';
import { useToggleRatcheting } from '@/client/hooks/use-toggle-ratcheting';
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
  const toggleRatcheting = useToggleRatcheting(workspace.projectId);

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
          <SpinnerGapIcon className="h-4 w-4 animate-spin" />
        ) : (
          <LightningIcon className="h-4 w-4" />
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
