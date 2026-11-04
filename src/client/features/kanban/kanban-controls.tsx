import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { useKanban } from './kanban-context';

export interface KanbanControlsViewProps {
  isMobile: boolean;
  isSyncing: boolean;
  onNewWorkspace: () => void;
  onRefresh: () => void;
}

/** Board header actions. "New Workspace" matches the sidebar action of the same name. */
export function KanbanControlsView({
  isMobile,
  isSyncing,
  onNewWorkspace,
  onRefresh,
}: KanbanControlsViewProps) {
  const newWorkspaceButton = (
    <Button
      size={isMobile ? 'icon' : 'sm'}
      className={isMobile ? 'h-8 w-8' : 'h-8'}
      onClick={onNewWorkspace}
      aria-label={isMobile ? 'New workspace' : undefined}
    >
      <PlusIcon className="h-4 w-4" />
      {isMobile ? null : 'New workspace'}
    </Button>
  );

  return (
    <>
      {isMobile ? (
        <Tooltip>
          <TooltipTrigger asChild>{newWorkspaceButton}</TooltipTrigger>
          <TooltipContent>New workspace</TooltipContent>
        </Tooltip>
      ) : (
        newWorkspaceButton
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={onRefresh}
            disabled={isSyncing}
            aria-label="Refresh workspaces"
          >
            <ArrowsClockwiseIcon className={cn('h-4 w-4', isSyncing && 'animate-spin')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Refresh workspaces</TooltipContent>
      </Tooltip>
    </>
  );
}

export function KanbanControls() {
  const { syncAndRefetch, isSyncing, requestInlineForm } = useKanban();
  const isMobile = useIsMobile();

  return (
    <KanbanControlsView
      isMobile={isMobile}
      isSyncing={isSyncing}
      onNewWorkspace={requestInlineForm}
      onRefresh={() => syncAndRefetch()}
    />
  );
}
