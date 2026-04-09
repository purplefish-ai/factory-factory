import { Archive, Loader2 } from 'lucide-react';
import { isWorkspaceDoneOrMerged } from '@/client/lib/workspace-archive';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { WorkspaceHeaderWorkspace } from './types';

export function ArchiveActionButton({
  workspace,
  archivePending,
  onArchiveRequest,
  renderAsMenuItem = false,
}: {
  workspace: WorkspaceHeaderWorkspace;
  archivePending: boolean;
  onArchiveRequest: () => void;
  renderAsMenuItem?: boolean;
}) {
  const completed = isWorkspaceDoneOrMerged(workspace);

  if (renderAsMenuItem) {
    return (
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => {
            onArchiveRequest();
          });
        }}
        disabled={archivePending}
        className={cn(
          completed ? '' : 'text-destructive focus:text-destructive dark:text-destructive'
        )}
      >
        {archivePending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Archive className="h-4 w-4" />
        )}
        {archivePending ? 'Archiving...' : 'Archive workspace'}
      </DropdownMenuItem>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={completed ? 'default' : 'ghost'}
          size="icon"
          className={cn(
            'h-9 w-9 md:h-8 md:w-8',
            completed ? '' : 'hover:bg-destructive/10 hover:text-destructive'
          )}
          onClick={onArchiveRequest}
          disabled={archivePending}
        >
          {archivePending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Archive className="h-4 w-4" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{archivePending ? 'Archiving...' : 'Archive'}</TooltipContent>
    </Tooltip>
  );
}
