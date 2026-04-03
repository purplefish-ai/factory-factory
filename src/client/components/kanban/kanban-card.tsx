import type { Workspace } from '@prisma-gen/browser';
import {
  AlertTriangle,
  Archive,
  GitBranch,
  GitPullRequest,
  MessageSquare,
  Pencil,
  Play,
  RefreshCw,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { PendingRequestBadge } from '@/client/components/pending-request-badge';
import { isWorkspaceDoneOrMerged } from '@/client/lib/workspace-archive';
import { CiStatusChip } from '@/components/shared/ci-status-chip';
import { SetupStatusChip } from '@/components/shared/setup-status-chip';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ArchiveWorkspaceDialog,
  RatchetToggleButton,
  WorkspaceStatusBadge,
} from '@/components/workspace';
import { cn } from '@/lib/utils';
import type { KanbanColumn, WorkspaceSidebarCiState, WorkspaceStatus } from '@/shared/core';
import { findWorkspaceSessionRuntimeError, type SessionSummary } from '@/shared/session-runtime';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';

export interface WorkspaceWithKanban extends Workspace {
  kanbanColumn: KanbanColumn | null;
  isWorking: boolean;
  sessionSummaries?: SessionSummary[];
  ratchetButtonAnimated?: boolean;
  flowPhase?: string | null;
  isArchived?: boolean;
  pendingRequestType?: 'plan_approval' | 'user_question' | 'permission_request' | null;
}

interface KanbanCardProps {
  workspace: WorkspaceWithKanban;
  projectSlug: string;
  onToggleRatcheting?: (workspaceId: string, enabled: boolean) => void;
  isTogglePending?: boolean;
  onArchive?: (workspaceId: string, commitUncommitted: boolean) => void;
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

function PullRequestRow({
  workspace,
  showPR,
}: {
  workspace: WorkspaceWithKanban;
  showPR: boolean;
}) {
  if (!showPR) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground min-w-0">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          window.open(workspace.prUrl as string, '_blank', 'noopener,noreferrer');
        }}
        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <GitPullRequest className="h-3 w-3 shrink-0" />
        <span>#{workspace.prNumber}</span>
      </button>
    </div>
  );
}

function BranchRow({ branchName }: { branchName: string | null }) {
  if (!branchName) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground min-w-0">
      <GitBranch className="h-3 w-3 shrink-0" />
      <span className="font-mono truncate">{branchName}</span>
    </div>
  );
}

function CiRow({
  ciState,
  prState,
}: {
  ciState: WorkspaceSidebarCiState;
  prState: Workspace['prState'];
}) {
  return <CiStatusChip ciState={ciState} prState={prState} size="sm" />;
}

function CardArchiveButton({
  workspace,
  onArchive,
}: {
  workspace: WorkspaceWithKanban;
  onArchive: (workspaceId: string, commitUncommitted: boolean) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const requiresConfirmation = !isWorkspaceDoneOrMerged(workspace);

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!requiresConfirmation) {
      onArchive(workspace.id, true);
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
              requiresConfirmation && 'opacity-0 group-hover:opacity-100 transition-opacity'
            )}
            onClick={handleClick}
          >
            <Archive className="h-3 w-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Archive workspace</TooltipContent>
      </Tooltip>
      {requiresConfirmation && (
        <ArchiveWorkspaceDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          hasUncommitted={false}
          onConfirm={(commitUncommitted) => onArchive(workspace.id, commitUncommitted)}
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
  onArchive?: (workspaceId: string, commitUncommitted: boolean) => void;
  onOpenQuickChat?: (workspaceId: string) => void;
  onStartEdit?: () => void;
}) {
  const showQuickChat =
    !isArchived &&
    workspace.status !== 'NEW' &&
    workspace.status !== 'PROVISIONING' &&
    onOpenQuickChat;
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {onStartEdit && !isArchived && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onStartEdit();
              }}
            >
              <Pencil className="h-3 w-3" />
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
                !workspace.pendingRequestType &&
                  'md:opacity-0 md:group-hover:opacity-100 transition-opacity'
              )}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onOpenQuickChat(workspace.id);
              }}
            >
              <MessageSquare className="h-3 w-3" />
              {workspace.pendingRequestType && (
                <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-500" />
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
        disabled={isTogglePending || isArchived || !onToggleRatcheting}
        stopPropagation
        onToggle={(enabled) => {
          onToggleRatcheting?.(workspace.id, enabled);
        }}
      />
      {workspace.runScriptStatus === 'RUNNING' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Play className="h-3 w-3 text-green-500 fill-green-500 animate-pulse" />
            </span>
          </TooltipTrigger>
          <TooltipContent>Dev server running</TooltipContent>
        </Tooltip>
      )}
      {sessionRuntimeError && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <AlertTriangle className="h-3 w-3 text-amber-500" />
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
  const showPR = Boolean(workspace.prState !== 'NONE' && workspace.prNumber && workspace.prUrl);
  const isArchived =
    workspace.isArchived || workspace.status === 'ARCHIVING' || workspace.status === 'ARCHIVED';
  const ratchetEnabled = workspace.ratchetEnabled ?? true;
  const sidebarStatus = deriveWorkspaceSidebarStatus({
    isWorking: workspace.isWorking,
    prUrl: workspace.prUrl ?? null,
    prState: workspace.prState ?? null,
    prCiStatus: workspace.prCiStatus ?? null,
    ratchetState: workspace.ratchetState ?? null,
  });
  const sessionRuntimeError = findWorkspaceSessionRuntimeError(workspace.sessionSummaries)?.message;
  const showSetup = workspace.status === 'NEW' || workspace.status === 'PROVISIONING';
  const showCi = sidebarStatus.ciState !== 'NONE';
  const showBranch = Boolean(workspace.branchName);
  const showPendingRequest = workspace.pendingRequestType;
  const hasMetadata =
    showSetup || showCi || showBranch || showPR || showPendingRequest || !!sessionRuntimeError;
  return {
    showPR,
    isArchived,
    ratchetEnabled,
    sidebarStatus,
    sessionRuntimeError: sessionRuntimeError ?? null,
    showSetup,
    showCi,
    showBranch,
    showPendingRequest,
    hasMetadata,
  };
}

function AutoIterationBadge({ workspace }: { workspace: WorkspaceWithKanban }) {
  const progress = workspace.autoIterationProgress as {
    currentIteration?: number;
    currentMetricSummary?: string;
  } | null;
  const config = workspace.autoIterationConfig as { maxIterations?: number } | null;
  const status = workspace.autoIterationStatus;
  const current = progress?.currentIteration ?? 0;
  const max = config?.maxIterations ?? 25;
  const maxLabel = max === 0 ? '∞' : String(max);
  const isRunning = status === 'RUNNING';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 text-[11px] text-primary/80">
          <RefreshCw className={cn('h-3 w-3', isRunning && 'animate-spin')} />
          <span className="font-mono">
            Iter {current}/{maxLabel}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <p>{progress?.currentMetricSummary || 'Auto-iteration workspace'}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export function KanbanCard({
  workspace,
  projectSlug,
  onToggleRatcheting,
  isTogglePending = false,
  onArchive,
  onOpenQuickChat,
  onRename,
}: KanbanCardProps) {
  const {
    showPR,
    isArchived,
    ratchetEnabled,
    sidebarStatus,
    sessionRuntimeError,
    showSetup,
    showCi,
    showBranch,
    showPendingRequest,
    hasMetadata,
  } = deriveCardState(workspace);

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(workspace.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleStartEdit = () => {
    if (isEditing) {
      return;
    }
    setEditValue(workspace.name);
    setIsEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const handleSaveRename = async () => {
    if (!isEditing) {
      return;
    }
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === workspace.name || !onRename) {
      setIsEditing(false);
      return;
    }
    try {
      await onRename(workspace.id, trimmed);
      setIsEditing(false);
    } catch {
      // Error is surfaced by the mutation's onError handler
      setIsEditing(false);
      setEditValue(workspace.name);
    }
  };

  const handleCancelRename = () => {
    setIsEditing(false);
    setEditValue(workspace.name);
  };

  return (
    <Link to={`/projects/${projectSlug}/workspaces/${workspace.id}`}>
      <Card
        className={cn(
          'group cursor-pointer hover:border-primary/50 transition-colors overflow-hidden relative',
          sessionRuntimeError && 'border-amber-500/40 bg-amber-500/5 hover:border-amber-500/60',
          workspace.isWorking && 'border-brand/50 bg-brand/5',
          workspace.pendingRequestType &&
            'border-amber-500/40 bg-amber-500/5 hover:border-amber-500/60',
          isArchived && 'opacity-60 border-dashed'
        )}
      >
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
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
                    handleCancelRename();
                  }
                  e.stopPropagation();
                }}
                onBlur={() => void handleSaveRename()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                className="flex-1 min-w-0 text-sm font-medium leading-tight bg-transparent border-b border-primary outline-none"
              />
            ) : (
              <CardTitle className="text-sm font-medium leading-tight line-clamp-2">
                {workspace.name}
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
              onStartEdit={onRename ? handleStartEdit : undefined}
            />
          </div>
        </CardHeader>
        {hasMetadata && (
          <CardContent className="space-y-1">
            {showSetup && (
              <div className="flex items-center">
                <SetupStatusChip status={workspace.status} />
              </div>
            )}
            {showCi && (
              <div className="flex items-center">
                <CiRow ciState={sidebarStatus.ciState} prState={workspace.prState} />
              </div>
            )}
            {showBranch && (
              <div className="flex items-center">
                <BranchRow branchName={workspace.branchName} />
              </div>
            )}
            {showPR && (
              <div className="flex items-center">
                <PullRequestRow workspace={workspace} showPR={showPR} />
              </div>
            )}
            {showPendingRequest && (
              <div className="flex items-center gap-2">
                <PendingRequestBadge type={showPendingRequest} />
              </div>
            )}
            {workspace.mode === 'AUTO_ITERATION' && <AutoIterationBadge workspace={workspace} />}
            {sessionRuntimeError && (
              <div className="flex items-center gap-2 text-[11px] text-amber-700 min-w-0">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                <span className="truncate">{sessionRuntimeError}</span>
              </div>
            )}
          </CardContent>
        )}
      </Card>
    </Link>
  );
}
