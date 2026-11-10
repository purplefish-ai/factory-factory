import { AppWindowIcon } from '@phosphor-icons/react/dist/csr/AppWindow';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 md:h-8 md:w-8"
          onClick={() => openInIde.mutate({ id: workspaceId })}
          pending={openInIde.isPending}
          pendingLabel={`Opening in ${preferredIdeName}…`}
          disabled={!hasWorktreePath}
          aria-label={`Open in ${preferredIdeName}`}
        >
          <AppWindowIcon className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Open in {preferredIdeName}</TooltipContent>
    </Tooltip>
  );
}
