import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { CheckSquareIcon } from '@phosphor-icons/react/dist/csr/CheckSquare';
import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree';
import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { useEffect, useRef } from 'react';
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
  /** Selection mode is on; the menu offers to leave it. */
  isSelecting?: boolean;
  onNewWorkspace: () => void;
  onRefresh: () => void;
  onToggleSelecting?: () => void;
}

/** Board overflow actions and a mobile shortcut to the Todo composer. */
export function KanbanControlsView({
  isMobile,
  isSyncing,
  isSelecting = false,
  onNewWorkspace,
  onRefresh,
  onToggleSelecting,
}: KanbanControlsViewProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Entering selection mode moves focus to the first card's checkbox, so the
  // closing menu must not return it to the trigger.
  const focusHandedOff = useRef(false);
  const wasSelecting = useRef(isSelecting);
  useEffect(() => {
    // Leaving selection mode removes the control that had focus (Cancel, the
    // action bar); give it back to the menu that started the mode.
    if (wasSelecting.current && !isSelecting && document.activeElement === document.body) {
      triggerRef.current?.focus();
    }
    wasSelecting.current = isSelecting;
  }, [isSelecting]);

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
          <IconButton ref={triggerRef} label="Board actions" size="icon-sm">
            <DotsThreeIcon />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (focusHandedOff.current) {
              focusHandedOff.current = false;
              event.preventDefault();
            }
          }}
        >
          <DropdownMenuItem onSelect={onRefresh} pending={isSyncing}>
            <ArrowsClockwiseIcon className="h-4 w-4" />
            {isSyncing ? 'Syncing…' : 'Sync now'}
          </DropdownMenuItem>
          {onToggleSelecting && (
            <DropdownMenuItem
              onSelect={() => {
                focusHandedOff.current = !isSelecting;
                onToggleSelecting();
              }}
            >
              <CheckSquareIcon className="h-4 w-4" />
              {isSelecting ? 'Stop selecting' : 'Select workspaces'}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

export function KanbanControls() {
  const {
    syncAndRefetch,
    isSyncing,
    requestInlineForm,
    isSelecting,
    startSelecting,
    stopSelecting,
  } = useKanban();
  const isMobile = useIsMobile();

  return (
    <KanbanControlsView
      isMobile={isMobile}
      isSyncing={isSyncing}
      isSelecting={isSelecting}
      onNewWorkspace={requestInlineForm}
      onRefresh={() => syncAndRefetch()}
      onToggleSelecting={isSelecting ? stopSelecting : startSelecting}
    />
  );
}
