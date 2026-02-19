import type { Workspace } from '@prisma-gen/browser';
import { Archive, GitBranch, GitPullRequest, Loader2, Play } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
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
import { PendingRequestBadge } from '@/frontend/components/pending-request-badge';
import { cn } from '@/lib/utils';
import type { KanbanColumn, WorkspaceSidebarCiState, WorkspaceStatus } from '@/shared/core';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';

export interface WorkspaceWithKanban extends Workspace {
  kanbanColumn: KanbanColumn | null;
  isWorking: boolean;
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
  isArchivePending?: boolean;
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

function GitContextRow({
  workspace,
  showPR,
  ciState,
}: {
  workspace: WorkspaceWithKanban;
  showPR: boolean;
  ciState: WorkspaceSidebarCiState;
}) {
  if (showPR) {
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
        {ciState !== 'NONE' && (
          <CiStatusChip ciState={ciState} prState={workspace.prState} size="sm" />
        )}
      </div>
    );
  }

  if (workspace.branchName) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground min-w-0">
        <GitBranch className="h-3 w-3 shrink-0" />
        <span className="font-mono truncate">{workspace.branchName}</span>
      </div>
    );
  }

  return null;
}

function CardArchiveButton({
  workspaceId,
  isPending,
  onArchive,
}: {
  workspaceId: string;
  isPending: boolean;
  onArchive: (workspaceId: string, commitUncommitted: boolean) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDialogOpen(true);
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/10 hover:text-destructive shrink-0"
            onClick={handleClick}
            disabled={isPending}
          >
            {isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Archive className="h-3 w-3" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Archive workspace</TooltipContent>
      </Tooltip>
      <ArchiveWorkspaceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        hasUncommitted={false}
        onConfirm={(commitUncommitted) => onArchive(workspaceId, commitUncommitted)}
      />
    </>
  );
}

function CardTitleIcons({
  workspace,
  ratchetEnabled,
  isTogglePending,
  isArchived,
  onToggleRatcheting,
  onArchive,
  isArchivePending,
}: {
  workspace: WorkspaceWithKanban;
  ratchetEnabled: boolean;
  isTogglePending: boolean;
  isArchived: boolean;
  onToggleRatcheting?: (workspaceId: string, enabled: boolean) => void;
  onArchive?: (workspaceId: string, commitUncommitted: boolean) => void;
  isArchivePending: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
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
      <CardStatusIndicator status={workspace.status} errorMessage={workspace.initErrorMessage} />
      {!isArchived && onArchive && (
        <CardArchiveButton
          workspaceId={workspace.id}
          isPending={isArchivePending}
          onArchive={onArchive}
        />
      )}
    </div>
  );
}

function deriveCardState(workspace: WorkspaceWithKanban) {
  const showPR = Boolean(workspace.prState !== 'NONE' && workspace.prNumber && workspace.prUrl);
  const isArchived = workspace.isArchived || workspace.status === 'ARCHIVED';
  const ratchetEnabled = workspace.ratchetEnabled ?? true;
  const sidebarStatus = deriveWorkspaceSidebarStatus({
    isWorking: workspace.isWorking,
    prUrl: workspace.prUrl ?? null,
    prState: workspace.prState ?? null,
    prCiStatus: workspace.prCiStatus ?? null,
    ratchetState: workspace.ratchetState ?? null,
  });
  const hasGitContext = showPR || Boolean(workspace.branchName);
  const hasPendingRequest = Boolean(workspace.pendingRequestType);
  const isSettingUp = workspace.status === 'NEW' || workspace.status === 'PROVISIONING';
  return {
    showPR,
    isArchived,
    ratchetEnabled,
    sidebarStatus,
    hasGitContext,
    hasPendingRequest,
    isSettingUp,
  };
}

export function KanbanCard({
  workspace,
  projectSlug,
  onToggleRatcheting,
  isTogglePending = false,
  onArchive,
  isArchivePending = false,
}: KanbanCardProps) {
  const {
    showPR,
    isArchived,
    ratchetEnabled,
    sidebarStatus,
    hasGitContext,
    hasPendingRequest,
    isSettingUp,
  } = deriveCardState(workspace);

  const hasBody = hasGitContext || hasPendingRequest || isSettingUp;

  return (
    <Link to={`/projects/${projectSlug}/workspaces/${workspace.id}`}>
      <Card
        className={cn(
          'group cursor-pointer hover:border-primary/50 transition-colors overflow-hidden relative',
          workspace.isWorking && 'border-brand/50 bg-brand/5',
          workspace.pendingRequestType &&
            'border-amber-500/40 bg-amber-500/5 hover:border-amber-500/60',
          isArchived && 'opacity-60 border-dashed'
        )}
      >
        <CardHeader className={hasBody ? 'pb-2' : 'pb-4'}>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-sm font-medium leading-tight line-clamp-2">
              {workspace.name}
            </CardTitle>
            <CardTitleIcons
              workspace={workspace}
              ratchetEnabled={ratchetEnabled}
              isTogglePending={isTogglePending}
              isArchived={isArchived}
              onToggleRatcheting={onToggleRatcheting}
              onArchive={onArchive}
              isArchivePending={isArchivePending}
            />
          </div>
        </CardHeader>
        {hasBody && (
          <CardContent className="space-y-2">
            <SetupStatusChip status={workspace.status} />
            <GitContextRow workspace={workspace} showPR={showPR} ciState={sidebarStatus.ciState} />
            {workspace.pendingRequestType && (
              <div className="flex items-center gap-2">
                <PendingRequestBadge type={workspace.pendingRequestType} />
              </div>
            )}
          </CardContent>
        )}
      </Card>
    </Link>
  );
}
