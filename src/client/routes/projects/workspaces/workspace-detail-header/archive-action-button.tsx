import { Archive, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { WorkspaceHeaderWorkspace } from './types';
import { isWorkspaceMerged } from './utils';

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
  const merged = isWorkspaceMerged(workspace);

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
          merged ? '' : 'text-destructive focus:text-destructive dark:text-destructive'
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
          variant={merged ? 'default' : 'ghost'}
          size="icon"
          className={cn(
            'h-9 w-9 md:h-8 md:w-8',
            merged ? '' : 'hover:bg-destructive/10 hover:text-destructive'
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
