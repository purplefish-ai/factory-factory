import { AppWindowIcon } from '@phosphor-icons/react/dist/csr/AppWindow';
import { IconButton } from '@/client/components/icon-button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import type { WorkspaceSessionManagement } from './types';

export function OpenInIdeAction({
  workspaceId,
  hasWorktreePath,
  availableIdes,
  preferredIde,
  openInIde,
  renderAsMenuItem = false,
}: {
  workspaceId: string;
  hasWorktreePath: boolean;
  availableIdes: WorkspaceSessionManagement['availableIdes'];
  preferredIde: WorkspaceSessionManagement['preferredIde'];
  openInIde: WorkspaceSessionManagement['openInIde'];
  renderAsMenuItem?: boolean;
}) {
  if (availableIdes.length === 0) {
    return null;
  }

  const preferredIdeName = availableIdes.find((ide) => ide.id === preferredIde)?.name ?? 'IDE';

  if (renderAsMenuItem) {
    return (
      <DropdownMenuItem
        onSelect={() => {
          openInIde.mutate({ id: workspaceId });
        }}
        pending={openInIde.isPending}
        disabled={!hasWorktreePath}
      >
        <AppWindowIcon className="h-4 w-4" />
        Open in {preferredIdeName}
      </DropdownMenuItem>
    );
  }

  return (
    <IconButton
      label={`Open in ${preferredIdeName}`}
      size="icon-sm"
      onClick={() => openInIde.mutate({ id: workspaceId })}
      pending={openInIde.isPending}
      pendingLabel={`Opening in ${preferredIdeName}…`}
      disabled={!hasWorktreePath}
    >
      <AppWindowIcon />
    </IconButton>
  );
}
