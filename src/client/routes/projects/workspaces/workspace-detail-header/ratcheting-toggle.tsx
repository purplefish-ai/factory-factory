import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import {
  ConnectedWorkspacePrMenu,
  getRatchetStateLabel,
  RatchetWrenchIcon,
} from '@/client/features/workspace';
import { Button } from '@/components/ui/button';
import type { WorkspaceHeaderWorkspace } from './types';

export function RatchetingToggle({
  workspace,
  workspaceId,
}: {
  workspace: WorkspaceHeaderWorkspace;
  workspaceId: string;
}) {
  const enabled = workspace.ratchetEnabled ?? false;
  const updateState = enabled ? `on (${getRatchetStateLabel(workspace.ratchetState)})` : 'off';
  const readOnly = workspace.status === 'ARCHIVED' || workspace.status === 'ARCHIVING';
  return (
    <ConnectedWorkspacePrMenu
      key={workspaceId}
      workspaceId={workspaceId}
      projectId={workspace.projectId}
      prs={workspace.prs}
      monitoring={workspace.prMonitoring}
      readOnly={readOnly}
      reviewEnabled={Boolean(workspace.worktreePath)}
      trigger={
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 data-[state=open]:bg-accent"
          aria-label={`Pull requests and updates, updates ${updateState}`}
          title={`PR updates ${updateState}`}
        >
          <RatchetWrenchIcon
            enabled={enabled}
            animated={workspace.ratchetButtonAnimated ?? false}
            className="size-4"
          />
          <CaretDownIcon className="size-3 text-muted-foreground" />
        </Button>
      }
    />
  );
}
