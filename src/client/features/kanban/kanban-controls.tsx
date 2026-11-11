import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree';
import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { IconButton } from '@/client/components/icon-button';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
    <Button className="shrink-0" onClick={onNewWorkspace}>
      <PlusIcon />
      New workspace
    </Button>
  );

  return (
    <>
      {isMobile && newWorkspaceButton}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label="Board actions" size="icon-sm">
            <DotsThreeIcon />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onRefresh} pending={isSyncing}>
            <ArrowsClockwiseIcon className="h-4 w-4" />
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
