import { MoreHorizontal, Pencil, Settings2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
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
import { RatchetingToggle } from './ratcheting-toggle';
import type { WorkspaceHeaderWorkspace, WorkspaceSessionManagement } from './types';
import { WorkspaceBranchLink } from './workspace-branch-link';
import { WorkspaceProviderSettings } from './workspace-provider-settings';

export function WorkspaceHeaderOverflowMenu({
  workspace,
  workspaceId,
  availableIdes,
  preferredIde,
  openInIde,
  archivePending,
  onArchiveRequest,
}: {
  workspace: WorkspaceHeaderWorkspace;
  workspaceId: string;
  availableIdes: WorkspaceSessionManagement['availableIdes'];
  preferredIde: WorkspaceSessionManagement['preferredIde'];
  openInIde: WorkspaceSessionManagement['openInIde'];
  archivePending: boolean;
  onArchiveRequest: () => void;
}) {
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const utils = trpc.useUtils();
  const renameMutation = trpc.workspace.rename.useMutation({
    onError: (error) => toast.error(`Failed to rename workspace: ${error.message}`),
  });

  const handleRenameOpen = () => {
    setRenameValue(workspace.name);
    setRenameOpen(true);
    requestAnimationFrame(() => {
      inputRef.current?.select();
    });
  };

  const handleRenameSubmit = async () => {
    const trimmed = renameValue.trim();
    if (renameMutation.isPending) {
      return;
    }
    if (!trimmed || trimmed === workspace.name) {
      setRenameOpen(false);
      return;
    }
    try {
      await renameMutation.mutateAsync({ id: workspaceId, name: trimmed });
      await Promise.all([
        utils.workspace.get.invalidate({ id: workspaceId }),
        utils.workspace.getProjectSummaryState.invalidate({ projectId: workspace.projectId }),
        utils.workspace.listWithKanbanState.invalidate({ projectId: workspace.projectId }),
      ]);
      setRenameOpen(false);
    } catch {
      // onError handles user feedback via toast
    }
  };

  return (
    <>
      <WorkspaceProviderSettings
        workspace={workspace}
        workspaceId={workspaceId}
        open={providerSettingsOpen}
        onOpenChange={setProviderSettingsOpen}
        showTrigger={false}
      />
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
          </DialogHeader>
          <Input
            ref={inputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!renameMutation.isPending) {
                  void handleRenameSubmit();
                }
              } else if (e.key === 'Escape') {
                setRenameOpen(false);
              }
            }}
            placeholder="Workspace name"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleRenameSubmit()}
              disabled={!renameValue.trim() || renameMutation.isPending}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 md:h-9 md:w-9"
                aria-label="More actions"
              >
                <MoreHorizontal className="h-3 w-3 md:h-4 md:w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel>Workspace actions</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              requestAnimationFrame(() => {
                handleRenameOpen();
              });
            }}
          >
            <Pencil className="h-4 w-4" />
            Rename workspace
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              requestAnimationFrame(() => {
                setProviderSettingsOpen(true);
              });
            }}
          >
            <Settings2 className="h-4 w-4" />
            Provider settings
          </DropdownMenuItem>
          <RatchetingToggle workspace={workspace} workspaceId={workspaceId} renderAsMenuItem />
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
            onArchiveRequest={onArchiveRequest}
            renderAsMenuItem
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
