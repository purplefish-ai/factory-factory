import { GitPullRequest, Info, Pencil } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  HeaderLeftExtraSlot,
  HeaderLeftStartSlot,
  HeaderRightSlot,
  useAppHeader,
} from '@/client/components/app-header-context';
import { ProjectSelectorDropdown } from '@/client/components/project-selector';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { RunScriptButton, RunScriptPortBadge } from '@/components/workspace';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { useWorkspaceProjectNavigation } from './use-workspace-project-navigation';
import {
  ArchiveActionButton,
  getWorkspaceHeaderLabel,
  OpenInIdeAction,
  RatchetingToggle,
  ToggleRightPanelButton,
  WorkspaceBranchLink,
  WorkspaceCiStatus,
  WorkspaceHeaderOverflowMenu,
  type WorkspaceHeaderProps,
  WorkspaceIssueLink,
  WorkspacePrAction,
  WorkspaceProviderSettings,
  WorkspaceSwitcherDropdown,
} from './workspace-detail-header/index';

/**
 * Component that injects workspace header content into the app-level header
 * via portal slots. Rendered inside WorkspaceDetailContainer.
 */
export function WorkspaceDetailHeaderSlot({
  workspace,
  workspaceId,
  availableIdes,
  preferredIde,
  openInIde,
  archivePending,
  onArchiveRequest,
  handleQuickAction,
  running,
  isCreatingSession,
  hasChanges,
}: WorkspaceHeaderProps) {
  const isMobile = useIsMobile();
  const { slug, projects, handleProjectChange, handleCurrentProjectSelect } =
    useWorkspaceProjectNavigation();

  const utils = trpc.useUtils();
  const renameMutation = trpc.workspace.rename.useMutation({
    onError: (error) => toast.error(`Failed to rename workspace: ${error.message}`),
  });

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(workspace.name);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [attachPrOpen, setAttachPrOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleStartEdit = () => {
    setEditValue(workspace.name);
    setIsEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const handleSaveRename = async () => {
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === workspace.name) {
      setIsEditing(false);
      return;
    }
    try {
      await renameMutation.mutateAsync({ id: workspaceId, name: trimmed });
      await Promise.all([
        utils.workspace.getProjectSummaryState.invalidate({ projectId: workspace.projectId }),
        utils.workspace.get.invalidate({ id: workspaceId }),
      ]);
      setIsEditing(false);
    } catch {
      setIsEditing(false);
      setEditValue(workspace.name);
    }
  };

  const isArchived = workspace.status === 'ARCHIVED' || workspace.status === 'ARCHIVING';

  useAppHeader({ title: '' });

  return (
    <>
      <HeaderLeftStartSlot>
        <div className="flex min-w-0 items-center gap-0.5">
          <ProjectSelectorDropdown
            selectedProjectSlug={slug}
            onProjectChange={handleProjectChange}
            onCurrentProjectSelect={handleCurrentProjectSelect}
            projects={projects}
            showLeadingSlash
            showTrailingSlash
            trailingSeparatorType="chevron"
            triggerId="workspace-detail-project-select"
          />
          {isEditing ? (
            <input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.blur();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setIsEditing(false);
                  setEditValue(workspace.name);
                }
                e.stopPropagation();
              }}
              onBlur={() => void handleSaveRename()}
              className="min-w-0 max-w-[18rem] text-sm font-semibold bg-transparent border-b border-primary outline-none"
            />
          ) : (
            <div className="group flex items-center gap-0.5">
              <WorkspaceSwitcherDropdown
                projectSlug={slug}
                projectId={workspace.projectId}
                currentWorkspaceId={workspaceId}
                currentWorkspaceLabel={getWorkspaceHeaderLabel(
                  workspace.branchName,
                  workspace.name,
                  isMobile
                )}
                currentWorkspaceName={workspace.name}
              />
              {!isArchived && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={handleStartEdit}
                  aria-label="Rename workspace"
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => setDetailsOpen(true)}
                aria-label="View workspace details"
              >
                <Info className="h-3 w-3" />
              </Button>
              {!isArchived && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => setAttachPrOpen(true)}
                  aria-label={workspace.prUrl ? 'Edit associated PR' : 'Associate a PR'}
                >
                  <GitPullRequest className="h-3 w-3" />
                </Button>
              )}
            </div>
          )}
        </div>
      </HeaderLeftStartSlot>
      <HeaderLeftExtraSlot>
        <div className="hidden md:flex items-center gap-2 min-w-0">
          <WorkspacePrAction
            workspace={workspace}
            hasChanges={hasChanges}
            running={running}
            isCreatingSession={isCreatingSession}
            handleQuickAction={handleQuickAction}
          />
          <WorkspaceIssueLink workspace={workspace} />
          <WorkspaceCiStatus workspace={workspace} />
          <RunScriptPortBadge workspaceId={workspaceId} />
        </div>
      </HeaderLeftExtraSlot>
      <HeaderRightSlot>
        <div className={cn('flex items-center gap-0.5 shrink-0', !isMobile && 'flex-wrap gap-0.5')}>
          <RunScriptButton workspaceId={workspaceId} />
          {isMobile ? (
            <>
              <ToggleRightPanelButton />
              <WorkspaceHeaderOverflowMenu
                workspace={workspace}
                workspaceId={workspaceId}
                availableIdes={availableIdes}
                preferredIde={preferredIde}
                openInIde={openInIde}
                archivePending={archivePending}
                onArchiveRequest={onArchiveRequest}
              />
            </>
          ) : (
            <>
              <WorkspaceProviderSettings workspace={workspace} workspaceId={workspaceId} />
              <RatchetingToggle workspace={workspace} workspaceId={workspaceId} />
              <WorkspaceBranchLink workspace={workspace} />
              <OpenInIdeAction
                workspaceId={workspaceId}
                hasWorktreePath={Boolean(workspace.worktreePath)}
                availableIdes={availableIdes}
                preferredIde={preferredIde}
                openInIde={openInIde}
              />
              <ArchiveActionButton
                workspace={workspace}
                archivePending={archivePending}
                onArchiveRequest={onArchiveRequest}
              />
              <ToggleRightPanelButton />
            </>
          )}
        </div>
      </HeaderRightSlot>
      <WorkspaceDetailsDialog
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        workspace={workspace}
      />
      <AttachPrDialog
        open={attachPrOpen}
        onOpenChange={setAttachPrOpen}
        workspaceId={workspaceId}
        currentPrUrl={workspace.prUrl ?? undefined}
      />
    </>
  );
}

function AttachPrDialog({
  open,
  onOpenChange,
  workspaceId,
  currentPrUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  currentPrUrl?: string;
}) {
  const utils = trpc.useUtils();
  const [value, setValue] = useState(currentPrUrl ?? '');
  const [error, setError] = useState<string | null>(null);

  const attachPrMutation = trpc.workspace.attachPR.useMutation({
    onSuccess: async () => {
      await utils.workspace.get.invalidate({ id: workspaceId });
      onOpenChange(false);
      toast.success('PR associated successfully');
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setValue(currentPrUrl ?? '');
      setError(null);
    }
    onOpenChange(next);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    attachPrMutation.mutate({ id: workspaceId, prUrl: value.trim() });
  };

  // Sync input value when dialog opens
  useEffect(() => {
    if (open) {
      setValue(currentPrUrl ?? '');
      setError(null);
    }
  }, [open, currentPrUrl]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby="attach-pr-description">
        <DialogHeader>
          <DialogTitle>{currentPrUrl ? 'Edit associated PR' : 'Associate a PR'}</DialogTitle>
          <DialogDescription id="attach-pr-description">
            Enter the GitHub PR URL to link it to this workspace. The ratchet will use this PR to
            monitor CI and review status.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Input
              type="url"
              placeholder="https://github.com/owner/repo/pull/123"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              autoFocus
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!value.trim() || attachPrMutation.isPending}>
              {attachPrMutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function WorkspaceDetailsDialog({
  open,
  onOpenChange,
  workspace,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: WorkspaceHeaderProps['workspace'];
}) {
  const metadata = workspace.creationMetadata as Record<string, unknown> | null | undefined;
  const initialPrompt = typeof metadata?.initialPrompt === 'string' ? metadata.initialPrompt : null;
  const hasContent = workspace.description || initialPrompt;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Workspace details</DialogTitle>
        </DialogHeader>
        {hasContent ? (
          <div className="flex flex-col gap-4">
            {workspace.description && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Description
                </span>
                <p className="text-sm whitespace-pre-wrap">{workspace.description}</p>
              </div>
            )}
            {initialPrompt && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Initial prompt
                </span>
                <p className="text-sm whitespace-pre-wrap">{initialPrompt}</p>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No description or initial prompt was provided for this workspace.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
