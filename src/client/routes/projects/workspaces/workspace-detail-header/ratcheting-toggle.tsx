import { LightningIcon, SpinnerGapIcon } from '@phosphor-icons/react';
import { RatchetToggleButton } from '@/client/features/workspace';
import { useToggleRatcheting } from '@/client/hooks/use-toggle-ratcheting';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import type { WorkspaceHeaderWorkspace } from './types';

export function RatchetingToggle({
  workspace,
  workspaceId,
}: {
  workspace: WorkspaceHeaderWorkspace;
  workspaceId: string;
}) {
  const toggleRatcheting = useToggleRatcheting(workspace.projectId);

  const workspaceRatchetEnabled = workspace.ratchetEnabled ?? false;

  return (
    <>
      {toggleRatcheting.recipientPicker}
      <RatchetToggleButton
        enabled={workspaceRatchetEnabled}
        state={workspace.ratchetState}
        animated={workspace.ratchetButtonAnimated ?? false}
        disabled={toggleRatcheting.isPending}
        onToggle={(enabled) => {
          toggleRatcheting.mutate({ workspaceId, enabled });
        }}
      />
    </>
  );
}

export function RatchetingMenuItems({
  workspace,
  workspaceId,
  toggleRatcheting,
}: {
  workspace: WorkspaceHeaderWorkspace;
  workspaceId: string;
  toggleRatcheting: ReturnType<typeof useToggleRatcheting>;
}) {
  const workspaceRatchetEnabled = workspace.ratchetEnabled ?? false;
  return (
    <>
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
        {workspaceRatchetEnabled ? 'Turn off PR updates' : 'Turn on PR updates'}
      </DropdownMenuItem>
      {workspaceRatchetEnabled && (
        <DropdownMenuItem
          disabled={toggleRatcheting.isPending}
          onSelect={() =>
            toggleRatcheting.mutate({ workspaceId, enabled: true, recipientSessionId: null })
          }
        >
          Change PR update conversation
        </DropdownMenuItem>
      )}
    </>
  );
}
