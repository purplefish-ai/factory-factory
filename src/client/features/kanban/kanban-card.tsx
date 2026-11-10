import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';
import { ChatIcon } from '@phosphor-icons/react/dist/csr/Chat';
import { DotOutlineIcon } from '@phosphor-icons/react/dist/csr/DotOutline';
import { GitBranchIcon } from '@phosphor-icons/react/dist/csr/GitBranch';
import { GitPullRequestIcon } from '@phosphor-icons/react/dist/csr/GitPullRequest';
import { PencilIcon } from '@phosphor-icons/react/dist/csr/Pencil';
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { memo, type RefObject, useState } from 'react';
import { Link } from 'react-router';
import { UnreadMailBadge } from '@/client/features/inbox';
import {
  ArchiveWorkspaceDialog,
  ConnectedWorkspacePrMenu,
  RatchetToggleButton,
  WorkspaceStatusBadge,
  WorkspaceFamilyMenu,
  WorkspaceParentLink,
} from '@/client/features/workspace';
import { useInlineWorkspaceRename } from '@/client/hooks/use-inline-workspace-rename';
import { trpc } from '@/client/lib/trpc';
import { isWorkspaceDoneOrMerged } from '@/client/lib/workspace-archive';
import { getWorkspaceSelectedPR } from '@/client/lib/workspace-selected-pr';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { WorkspaceStatus } from '@/shared/core';
import { findWorkspaceSessionRuntimeError } from '@/shared/session-runtime';
import type { WorkspaceSummary } from '@/shared/workspace-summary';
import { KanbanStatusChip } from './kanban-card-status-chip';
import { useKanbanFamilyHighlight } from './kanban-family-highlight';
import { KanbanPrStates } from './kanban-pr-states';

/**
 * A card renders one row of the shared project workspace list, so its props
 * follow that endpoint rather than the database row. Anything a card needs is
 * added to the list payload once, for every surface that reads it.
 */
export type WorkspaceWithKanban = WorkspaceSummary<Date>;

export interface KanbanCardProps {
  workspace: WorkspaceWithKanban;
  projectSlug: string;
  unreadCount?: number;
  onToggleRatcheting?: (workspaceId: string, enabled: boolean) => void;
  isTogglePending?: boolean;
  onArchive?: (workspaceId: string) => void;
  onOpenQuickChat?: (workspaceId: string) => void;
  onRename?: (workspaceId: string, name: string) => Promise<void>;
}

function CardStatusIndicator({
  status,
  errorMessage,
}: {
  status: WorkspaceStatus;
  errorMessage: string | null;
}) {
  // NEW/PROVISIONING are shown as a label in the card body instead
  if (status === 'NEW' || status === 'PROVISIONING') {
    return null;
  }

  return <WorkspaceStatusBadge status={status} errorMessage={errorMessage} />;
}

type IssueLink = {
  label: string;
  url: string;
};

function deriveIssueLink(workspace: WorkspaceWithKanban): IssueLink | null {
  if (workspace.linearIssueIdentifier && workspace.linearIssueUrl) {
    return {
      label: workspace.linearIssueIdentifier,
      url: workspace.linearIssueUrl,
    };
  }
  if (workspace.githubIssueNumber != null && workspace.githubIssueUrl) {
    return {
      label: `#${workspace.githubIssueNumber}`,
      url: workspace.githubIssueUrl,
    };
  }
  return null;
}

function IssueAndPullRequestRow({
  workspace,
  issue,
  showPR,
}: {
  workspace: WorkspaceWithKanban;
  issue: IssueLink | null;
  showPR: boolean;
}) {
  const selectedPr = getWorkspaceSelectedPR(workspace);
  if (!(issue || showPR || workspace.prs?.length)) {
    return null;
  }

  return (
    <div
      data-testid="issue-pr-row"
      className="pointer-events-none relative z-10 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground min-w-0 [&_button]:pointer-events-auto [&_a]:pointer-events-auto"
    >
      {issue && (
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            window.open(issue.url, '_blank', 'noopener,noreferrer');
          }}
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <DotOutlineIcon className="h-3 w-3 shrink-0" />
          <span>{issue.label}</span>
        </button>
      )}
      {workspace.prs?.length ? (
        <div className="inline-flex items-center gap-1.5">
          <ConnectedWorkspacePrMenu
            workspaceId={workspace.id}
            projectId={workspace.projectId}
            prs={workspace.prs}
            monitoring={workspace.prMonitoring}
            reviewEnabled={Boolean(workspace.worktreePath)}
            readOnly={workspace.status === 'ARCHIVED' || workspace.status === 'ARCHIVING'}
            compact
          />
          <KanbanPrStates prs={workspace.prs} />
        </div>
      ) : (
        showPR &&
        selectedPr && (
          <div className="inline-flex items-center gap-1.5">
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                window.open(selectedPr.url, '_blank', 'noopener,noreferrer');
              }}
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              <GitPullRequestIcon className="h-3 w-3 shrink-0" />
              <span>#{selectedPr.number}</span>
            </button>
            <KanbanPrStates prs={[selectedPr]} />
          </div>
        )
      )}
    </div>
  );
}
function BranchRow({ branchName }: { branchName: string | null }) {
  if (!branchName) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 text-2xs text-muted-foreground min-w-0">
      <GitBranchIcon className="h-3 w-3 shrink-0" />
      <span className="font-mono truncate">{branchName}</span>
    </div>
  );
}

function CardArchiveButton({
  workspace,
  onArchive,
}: {
  workspace: WorkspaceWithKanban;
  onArchive: (workspaceId: string) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const requiresConfirmation = !isWorkspaceDoneOrMerged(workspace);
  const isParent = workspace.creationSource !== 'CHILD_WORKSPACE';
  const { data: children } = trpc.workspace.listChildren.useQuery(
    { parentWorkspaceId: workspace.id },
    { enabled: requiresConfirmation && dialogOpen && isParent }
  );
  const activeChildCount = children?.length ?? 0;

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!requiresConfirmation) {
      onArchive(workspace.id);
      return;
    }
    setDialogOpen(true);
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'h-6 w-6 hover:bg-destructive/10 hover:text-destructive shrink-0',
              requiresConfirmation && 'hover-reveal transition-opacity'
            )}
            onClick={handleClick}
            aria-label="Archive workspace"
          >
            <ArchiveIcon className="h-3 w-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Archive workspace</TooltipContent>
      </Tooltip>
      {requiresConfirmation && (
        <ArchiveWorkspaceDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onConfirm={() => onArchive(workspace.id)}
          activeChildCount={activeChildCount}
        />
      )}
    </>
  );
}

function CardTitleIcons({
  workspace,
  ratchetEnabled,
  isTogglePending,
  isArchived,
  sessionRuntimeError,
  onToggleRatcheting,
  onArchive,
  onOpenQuickChat,
  onStartEdit,
}: {
  workspace: WorkspaceWithKanban;
  ratchetEnabled: boolean;
  isTogglePending: boolean;
  isArchived: boolean;
  sessionRuntimeError: string | null;
  onToggleRatcheting?: (workspaceId: string, enabled: boolean) => void;
  onArchive?: (workspaceId: string) => void;
  onOpenQuickChat?: (workspaceId: string) => void;
  onStartEdit?: () => void;
}) {
  const showQuickChat =
    !isArchived &&
    workspace.status !== 'NEW' &&
    workspace.status !== 'PROVISIONING' &&
    onOpenQuickChat;
  return (
    <div className="relative z-10 flex items-center gap-1.5 [@media(any-pointer:coarse)]:gap-0 shrink-0">
      {onStartEdit && !isArchived && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 hover-reveal transition-opacity"
              aria-label="Rename workspace"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onStartEdit();
              }}
            >
              <PencilIcon className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Rename workspace</TooltipContent>
        </Tooltip>
      )}
      {showQuickChat && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'h-6 w-6 shrink-0 relative',
                !workspace.pendingRequestType && 'hover-reveal transition-opacity'
              )}
              aria-label="Quick Chat"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onOpenQuickChat(workspace.id);
              }}
            >
              <ChatIcon className="h-3 w-3" />
              {workspace.pendingRequestType && (
                <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-warning" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Quick Chat</TooltipContent>
        </Tooltip>
      )}
      <RatchetToggleButton
        enabled={ratchetEnabled}
        state={workspace.ratchetState}
        animated={workspace.ratchetButtonAnimated ?? false}
        className="h-5 w-5 shrink-0"
        pending={isTogglePending}
        disabled={isArchived || !onToggleRatcheting}
        stopPropagation
        onToggle={(enabled) => {
          onToggleRatcheting?.(workspace.id, enabled);
        }}
      />
      {workspace.runScriptStatus === 'RUNNING' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <PlayIcon
                className="h-3 w-3 text-running animate-pulse motion-reduce:animate-none"
                weight="fill"
              />
            </span>
          </TooltipTrigger>
          <TooltipContent>Dev server running</TooltipContent>
        </Tooltip>
      )}
      {sessionRuntimeError && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <WarningIcon className="h-3 w-3 text-destructive" />
            </span>
          </TooltipTrigger>
          <TooltipContent>{sessionRuntimeError}</TooltipContent>
        </Tooltip>
      )}
      <CardStatusIndicator status={workspace.status} errorMessage={workspace.initErrorMessage} />
      {!isArchived && onArchive && (
        <CardArchiveButton workspace={workspace} onArchive={onArchive} />
      )}
    </div>
  );
}

function deriveCardState(workspace: WorkspaceWithKanban) {
  const selectedPr = getWorkspaceSelectedPR(workspace);
  const showPR = Boolean(selectedPr && selectedPr.state !== 'NONE' && selectedPr.number);
  const issue = deriveIssueLink(workspace);
  const isArchived = workspace.status === 'ARCHIVING' || workspace.status === 'ARCHIVED';
  const ratchetEnabled = workspace.ratchetEnabled ?? true;
  const sessionRuntimeError = findWorkspaceSessionRuntimeError(workspace.sessionSummaries)?.message;
  const showBranch = Boolean(workspace.branchName);
  const hasMetadata =
    Boolean(workspace.conversationSummary) ||
    Boolean(workspace.statusReason) ||
    showBranch ||
    showPR ||
    Boolean(workspace.prs?.length) ||
    !!issue ||
    !!sessionRuntimeError ||
    workspace.creationSource === 'CHILD_WORKSPACE' ||
    Boolean(workspace.parentWorkspace || workspace.childWorkspaceCount);
  return {
    showPR,
    issue,
    isArchived,
    ratchetEnabled,
    sessionRuntimeError: sessionRuntimeError ?? null,
    showBranch,
    hasMetadata,
  };
}

function CardFamilyMetadata({
  workspace,
  projectSlug,
}: Pick<KanbanCardProps, 'workspace' | 'projectSlug'>) {
  return (
    <>
      {workspace.parentWorkspace || workspace.childWorkspaceCount ? (
        <div className="pointer-events-none relative z-10 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {workspace.parentWorkspace && (
            <WorkspaceParentLink
              parent={workspace.parentWorkspace}
              projectId={workspace.projectId}
            />
          )}
          <WorkspaceFamilyMenu
            key={workspace.id}
            workspace={workspace}
            projectSlug={projectSlug}
            compact
          />
        </div>
      ) : (
        workspace.creationSource === 'CHILD_WORKSPACE' && (
          <p className="text-2xs text-muted-foreground">Child workspace</p>
        )
      )}
    </>
  );
}

/** The card title while renaming; a spinner beside it shows the save is in flight. */
function InlineNameEditor({
  inputRef,
  value,
  isSaving,
  onChange,
  onSave,
  onCancel,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  isSaving: boolean;
  onChange: (value: string) => void;
  onSave: () => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <>
      <input
        ref={inputRef}
        readOnly={isSaving}
        aria-busy={isSaving}
        aria-label="Workspace name"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
          e.stopPropagation();
        }}
        onBlur={() => void onSave()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        className="relative z-10 flex-1 min-w-0 text-sm font-medium leading-tight bg-transparent border-b border-primary outline-none"
      />
      {isSaving && (
        <Spinner aria-label="Saving workspace name" className="size-3.5 text-muted-foreground" />
      )}
    </>
  );
}

export const KanbanCard = memo(function KanbanCard({
  workspace,
  projectSlug,
  unreadCount,
  onToggleRatcheting,
  isTogglePending = false,
  onArchive,
  onOpenQuickChat,
  onRename,
}: KanbanCardProps) {
  const { highlighted, ...familyEvents } = useKanbanFamilyHighlight(workspace);
  const {
    showPR,
    issue,
    isArchived,
    ratchetEnabled,
    sessionRuntimeError,
    showBranch,
    hasMetadata,
  } = deriveCardState(workspace);

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
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    name: workspace.name,
    onRename,
  });

  return (
    <Card
      {...familyEvents}
      data-workspace-id={workspace.id}
      data-family-highlighted={highlighted || undefined}
      className={cn(
        'group cursor-pointer hover:border-primary/50 transition-colors overflow-hidden relative',
        sessionRuntimeError && 'border-destructive/40 bg-destructive/5 hover:border-destructive/60',
        workspace.isWorking && 'border-running-accent/80 dark:border-running/50 dark:bg-running/5',
        workspace.pendingRequestType && 'border-warning/40 bg-warning/5 hover:border-warning/60',
        isArchived && 'opacity-60 border-dashed',
        highlighted && 'ring-2 ring-info/70 ring-inset'
      )}
    >
      <CardHeader className="pb-2">
        <div className="flex min-w-0 items-start justify-between gap-2">
          {isEditing ? (
            <InlineNameEditor
              inputRef={inputRef}
              value={editValue}
              isSaving={isSaving}
              onChange={setEditValue}
              onSave={handleSaveRename}
              onCancel={handleCancelRename}
            />
          ) : (
            <CardTitle className="flex flex-1 items-start gap-1.5 min-w-0 text-sm font-medium leading-tight">
              {workspace.creationSource === 'PERIODIC_TASK' && (
                <RobotIcon
                  role="img"
                  aria-label="Automation workspace"
                  className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground"
                />
              )}
              <Link
                to={`/projects/${projectSlug}/workspaces/${workspace.id}`}
                className="min-w-0 line-clamp-2 [overflow-wrap:anywhere] after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
              >
                {workspace.name}
              </Link>
              <UnreadMailBadge count={unreadCount} />
            </CardTitle>
          )}
          <CardTitleIcons
            workspace={workspace}
            ratchetEnabled={ratchetEnabled}
            isTogglePending={isTogglePending}
            isArchived={isArchived}
            sessionRuntimeError={sessionRuntimeError}
            onToggleRatcheting={onToggleRatcheting}
            onArchive={onArchive}
            onOpenQuickChat={onOpenQuickChat}
            onStartEdit={onRename && !isSaving ? handleStartEdit : undefined}
          />
        </div>
      </CardHeader>
      {hasMetadata && (
        <CardContent className="space-y-1">
          {workspace.conversationSummary && (
            <p
              className="line-clamp-2 text-xs text-muted-foreground"
              title={`${workspace.conversationSummary.summary}\nSummary updated ${new Date(workspace.conversationSummary.generatedAt).toLocaleString()}`}
            >
              {workspace.conversationSummary.summary}
            </p>
          )}
          {workspace.statusReason && <KanbanStatusChip statusReason={workspace.statusReason} />}
          <IssueAndPullRequestRow workspace={workspace} issue={issue} showPR={showPR} />
          {showBranch && (
            <div className="flex items-center">
              <BranchRow branchName={workspace.branchName} />
            </div>
          )}
          <CardFamilyMetadata workspace={workspace} projectSlug={projectSlug} />
          {sessionRuntimeError && (
            <div className="flex items-center gap-2 text-2xs text-destructive min-w-0">
              <WarningIcon className="h-3 w-3 shrink-0" />
              <span className="truncate">{sessionRuntimeError}</span>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
});
