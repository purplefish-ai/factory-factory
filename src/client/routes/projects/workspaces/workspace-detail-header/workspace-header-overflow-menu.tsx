import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree';
import { GearSixIcon } from '@phosphor-icons/react/dist/csr/GearSix';
import { InfoIcon } from '@phosphor-icons/react/dist/csr/Info';
import { PencilIcon } from '@phosphor-icons/react/dist/csr/Pencil';
import { type ReactNode, useRef, useState } from 'react';
import { useRenameWorkspace } from '@/client/features/workspace/use-workspace-mutations';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ArchiveActionButton } from './archive-action-button';
import { OpenDevAppAction } from './open-dev-app-action';
import { OpenInIdeAction } from './open-in-ide-action';
import type { WorkspaceHeaderWorkspace, WorkspaceSessionManagement } from './types';
import { WorkspaceBranchLink } from './workspace-branch-link';
import { WorkspaceDetailsDialog } from './workspace-details-dialog';
import { WorkspaceProviderSettings } from './workspace-provider-settings';

/**
 * Controls that the header also shows inline at wider widths. Each inline
 * wrapper carries `data-header-inline="<id>"`; the menu leaves out the ones
 * visible when it opens. The IDE action stays in the menu at every width.
 */
export type HeaderInlineControl = 'create-pr' | 'issue';

function getVisibleInlineControls(trigger: HTMLElement | null): ReadonlySet<string> {
  const header = trigger?.closest('header');
  if (!header) {
    return new Set();
  }
  return new Set(
    [...header.querySelectorAll<HTMLElement>('[data-header-inline]')]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => element.dataset.headerInline ?? '')
  );
}

export function WorkspaceHeaderOverflowMenu({
  workspace,
  workspaceId,
  availableIdes,
  preferredIde,
  openInIde,
  archivePending,
  onArchiveRequest,
  statusContent,
  isArchived,
}: {
  workspace: WorkspaceHeaderWorkspace;
  workspaceId: string;
  availableIdes: WorkspaceSessionManagement['availableIdes'];
  preferredIde: WorkspaceSessionManagement['preferredIde'];
  openInIde: WorkspaceSessionManagement['openInIde'];
  archivePending: boolean;
  onArchiveRequest: () => void;
  /** Items that are inline at wider widths; receives whether each is visible inline. */
  statusContent?: (isInline: (control: HeaderInlineControl) => boolean) => ReactNode;
  isArchived: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pendingDialog = useRef<(() => void) | null>(null);
  const [inlineControls, setInlineControls] = useState<ReadonlySet<string>>(new Set());
  const isInline = (control: HeaderInlineControl) => inlineControls.has(control);
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const renameMutation = useRenameWorkspace(workspace.projectId);

  const handleRenameOpen = () => {
    if (isArchived) {
      return;
    }
    setRenameValue(workspace.name);
    setRenameOpen(true);
    requestAnimationFrame(() => {
      inputRef.current?.select();
    });
  };

  const handleRenameSubmit = async () => {
    const trimmed = renameValue.trim();
    if (isArchived || renameMutation.isPending) {
      return;
    }
    if (!trimmed || trimmed === workspace.name) {
      setRenameOpen(false);
      return;
    }
    try {
      // Resolves once the new name has been refetched, so the dialog closes onto it.
      await renameMutation.mutateAsync({ id: workspaceId, name: trimmed });
      setRenameOpen(false);
    } catch {
      // The shared rename hook reports the failure; the dialog stays open to retry.
    }
  };

  // Like ConfirmDialog, the rename dialog stays open while the rename runs.
  const closeRename = () => {
    if (!renameMutation.isPending) {
      setRenameOpen(false);
    }
  };

  return (
    <>
      <WorkspaceDetailsDialog
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        workspace={workspace}
      />
      <WorkspaceProviderSettings
        workspace={workspace}
        workspaceId={workspaceId}
        open={providerSettingsOpen}
        onOpenChange={setProviderSettingsOpen}
      />
      <Dialog
        open={renameOpen && !isArchived}
        onOpenChange={(open) => (open ? setRenameOpen(true) : closeRename())}
      >
        <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
          </DialogHeader>
          <Input
            ref={inputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!renameMutation.isPending) {
                  void handleRenameSubmit();
                }
              } else if (e.key === 'Escape') {
                closeRename();
              }
            }}
            placeholder="Workspace name"
          />
          <DialogFooter>
            <Button variant="outline" onClick={closeRename} disabled={renameMutation.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleRenameSubmit()}
              pending={renameMutation.isPending}
              pendingLabel="Renaming…"
              disabled={!renameValue.trim()}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) {
            setInlineControls(getVisibleInlineControls(triggerRef.current));
          }
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                ref={triggerRef}
                variant="ghost"
                size="icon"
                className="h-6 w-6 md:h-8 md:w-8"
                aria-label="More actions"
              >
                <DotsThreeIcon className="h-3 w-3 md:h-4 md:w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="end"
          className="w-60"
          onCloseAutoFocus={(event) => {
            const action = pendingDialog.current;
            pendingDialog.current = null;
            if (action) {
              event.preventDefault();
              action();
            }
          }}
        >
          <DropdownMenuLabel>Workspace actions</DropdownMenuLabel>
          {statusContent?.(isInline)}
          <DropdownMenuItem
            onSelect={() => {
              pendingDialog.current = () => setDetailsOpen(true);
            }}
          >
            <InfoIcon className="h-4 w-4" />
            View details
          </DropdownMenuItem>
          {!isArchived && (
            <DropdownMenuItem
              onSelect={() => {
                pendingDialog.current = handleRenameOpen;
              }}
            >
              <PencilIcon className="h-4 w-4" />
              Rename workspace
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => {
              pendingDialog.current = () => setProviderSettingsOpen(true);
            }}
          >
            <GearSixIcon className="h-4 w-4" />
            Provider settings
          </DropdownMenuItem>
          <WorkspaceBranchLink workspace={workspace} renderAsMenuItem />
          <OpenInIdeAction
            workspaceId={workspaceId}
            hasWorktreePath={Boolean(workspace.worktreePath)}
            availableIdes={availableIdes}
            preferredIde={preferredIde}
            openInIde={openInIde}
            renderAsMenuItem
          />
          <OpenDevAppAction workspaceId={workspaceId} renderAsMenuItem />
          <DropdownMenuSeparator />
          <ArchiveActionButton
            workspace={workspace}
            archivePending={archivePending}
            onArchiveRequest={() => {
              pendingDialog.current = onArchiveRequest;
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
