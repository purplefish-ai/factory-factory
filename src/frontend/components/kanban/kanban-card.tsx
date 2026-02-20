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
  isPending,
  onArchive,
}: {
  workspace: WorkspaceWithKanban;
  isPending: boolean;
  onArchive: (workspaceId: string, commitUncommitted: boolean) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const requiresConfirmation = workspace.kanbanColumn !== 'DONE';

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
            className="h-6 w-6 hover:bg-destructive/10 hover:text-destructive shrink-0"
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
          workspace={workspace}
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
  return {
    showPR,
    isArchived,
    ratchetEnabled,
    sidebarStatus,
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
  const { showPR, isArchived, ratchetEnabled, sidebarStatus } = deriveCardState(workspace);
  const showSetup = workspace.status === 'NEW' || workspace.status === 'PROVISIONING';
  const showCi = sidebarStatus.ciState !== 'NONE';
  const showBranch = Boolean(workspace.branchName);
  const showPendingRequest = workspace.pendingRequestType;
  const hasMetadata = showSetup || showCi || showBranch || showPR || showPendingRequest;

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
        <CardHeader className="pb-2">
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
          </CardContent>
        )}
      </Card>
    </Link>
  );
}
