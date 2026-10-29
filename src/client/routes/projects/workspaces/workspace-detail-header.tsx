import { InfoIcon } from '@phosphor-icons/react/dist/csr/Info';
import { PencilIcon } from '@phosphor-icons/react/dist/csr/Pencil';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  HeaderLeftExtraSlot,
  HeaderLeftStartSlot,
  HeaderRightSlot,
  useAppHeader,
} from '@/client/components/app-header-context';
import { ProjectHeaderNavigation } from '@/client/components/project-header';
import { RunScriptButton, RunScriptPortBadge } from '@/client/features/workspace';
import { useInlineWorkspaceRename } from '@/client/hooks/use-inline-workspace-rename';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useIsMobile } from '@/hooks/use-mobile';
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
  const { slug, projects } = useWorkspaceProjectNavigation();
  const routeProject = trpc.project.getBySlug.useQuery({ slug }, { enabled: !!slug });

  const utils = trpc.useUtils();
  const renameMutation = trpc.workspace.rename.useMutation({
    onError: (error) => toast.error(`Failed to rename workspace: ${error.message}`),
  });

  const [detailsOpen, setDetailsOpen] = useState(false);
  const {
    isEditing,
    editValue,
    setEditValue,
    isSaving,
    inputRef,
    handleStartEdit,
    handleSaveRename,
    handleCancelRename,
  } = useInlineWorkspaceRename({
    workspaceId,
    projectId: workspace.projectId,
    name: workspace.name,
    onRename: async (id, name) => {
      await renameMutation.mutateAsync({ id, name });
      await Promise.all([
        utils.workspace.listForProject.invalidate({ projectId: workspace.projectId }),
        utils.workspace.get.invalidate({ id }),
      ]);
    },
  });

  const isArchived = workspace.status === 'ARCHIVED' || workspace.status === 'ARCHIVING';

  useAppHeader({ title: '' });

  return (
    <>
      <HeaderLeftStartSlot>
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          <div className="min-w-0 max-w-[50%] shrink md:max-w-[40%]">
            <ProjectHeaderNavigation
              showTrailingSlash
              triggerId="workspace-detail-project-select"
              project={
                routeProject.data ??
                projects?.find((candidate) => candidate.slug === slug) ?? {
                  id: workspace.projectId,
                  slug,
                  name: slug,
                }
              }
            />
          </div>
          {isEditing ? (
            <input
              ref={inputRef}
              readOnly={isSaving}
              aria-busy={isSaving}
              aria-label="Workspace name"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.blur();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  handleCancelRename();
                }
                e.stopPropagation();
              }}
              onBlur={() => void handleSaveRename()}
              className="min-w-0 w-0 flex-1 max-w-[24rem] text-sm font-semibold bg-transparent border-b border-primary outline-none"
            />
          ) : (
            <div className="group flex min-w-0 flex-1 items-center gap-0.5">
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
                  className="hidden @[72rem]/header:inline-flex h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={handleStartEdit}
                  disabled={isSaving}
                  aria-label="Rename workspace"
                >
                  <PencilIcon className="h-3 w-3" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="hidden @[72rem]/header:inline-flex h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => setDetailsOpen(true)}
                aria-label="View workspace details"
              >
                <InfoIcon className="h-3 w-3" />
              </Button>
            </div>
          )}
        </div>
      </HeaderLeftStartSlot>
      <HeaderLeftExtraSlot>
        <div className="hidden @[48rem]/header:flex shrink-0 items-center gap-2">
          <WorkspacePrAction
            workspace={workspace}
            hasChanges={hasChanges}
            running={running}
            isCreatingSession={isCreatingSession}
            handleQuickAction={(name, prompt) => {
              runInBackground(handleQuickAction(name, prompt), 'Could not run quick action');
            }}
          />
          <div className="hidden @[72rem]/header:flex items-center gap-2">
            <WorkspaceIssueLink workspace={workspace} />
            <RunScriptPortBadge workspaceId={workspaceId} />
          </div>
          <WorkspaceCiStatus workspace={workspace} />
        </div>
      </HeaderLeftExtraSlot>
      <HeaderRightSlot>
        <div className="flex shrink-0 items-center gap-0.5">
          <RunScriptButton workspaceId={workspaceId} />
          <RatchetingToggle workspace={workspace} workspaceId={workspaceId} />
          <div className="hidden @[72rem]/header:flex items-center gap-0.5">
            <WorkspaceProviderSettings workspace={workspace} workspaceId={workspaceId} />
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
          </div>
          <ToggleRightPanelButton />
          <div className="@[72rem]/header:hidden">
            <WorkspaceHeaderOverflowMenu
              workspace={workspace}
              workspaceId={workspaceId}
              availableIdes={availableIdes}
              preferredIde={preferredIde}
              openInIde={openInIde}
              archivePending={archivePending}
              onArchiveRequest={onArchiveRequest}
              statusContent={
                <>
                  <WorkspacePrAction
                    renderAsMenuItem
                    workspace={workspace}
                    hasChanges={hasChanges}
                    running={running}
                    isCreatingSession={isCreatingSession}
                    handleQuickAction={(name, prompt) => {
                      runInBackground(
                        handleQuickAction(name, prompt),
                        'Could not run quick action'
                      );
                    }}
                  />
                  <div className="px-2 py-1">
                    <WorkspaceCiStatus workspace={workspace} />
                  </div>
                  <WorkspaceIssueLink workspace={workspace} renderAsMenuItem />
                </>
              }
            />
          </div>
        </div>
      </HeaderRightSlot>
      <WorkspaceDetailsDialog
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        workspace={workspace}
      />
    </>
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
