import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree';
import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import { useKanban } from './kanban-context';

export interface KanbanControlsViewProps {
  isMobile: boolean;
  isSyncing: boolean;
  onNewWorkspace: () => void;
  onRefresh: () => void;
}

/** Board overflow actions and a mobile shortcut to the Todo composer. */
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
      {isMobile && (
        <Tooltip>
          <TooltipTrigger asChild>{newWorkspaceButton}</TooltipTrigger>
          <TooltipContent>New workspace</TooltipContent>
        </Tooltip>
      )}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Board actions">
                <DotsThreeIcon className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Board actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onRefresh} disabled={isSyncing}>
            {isSyncing ? (
              <Spinner className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ArrowsClockwiseIcon className="h-4 w-4" />
            )}
            {isSyncing ? 'Syncing…' : 'Sync now'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
