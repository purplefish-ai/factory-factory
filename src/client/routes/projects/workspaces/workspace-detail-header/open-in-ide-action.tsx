import { AppWindow, Loader2 } from 'lucide-react';
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
  const disabled = openInIde.isPending || !hasWorktreePath;

  if (renderAsMenuItem) {
    return (
      <DropdownMenuItem
        onSelect={() => {
          openInIde.mutate({ id: workspaceId });
        }}
        disabled={disabled}
      >
        {openInIde.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <AppWindow className="h-4 w-4" />
        )}
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
          className="h-9 w-9 md:h-8 md:w-8"
          onClick={() => openInIde.mutate({ id: workspaceId })}
          disabled={disabled}
        >
          {openInIde.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <AppWindow className="h-4 w-4" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Open in {preferredIdeName}</TooltipContent>
    </Tooltip>
  );
}
