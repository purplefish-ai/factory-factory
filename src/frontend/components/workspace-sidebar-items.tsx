import type { useSortable } from '@dnd-kit/sortable';
import {
  Archive,
  CheckCircle2,
  FileCheck,
  GitPullRequest,
  GripVertical,
  type LucideIcon,
  MessageCircleQuestion,
  Play,
  ShieldAlert,
} from 'lucide-react';
import { Link } from 'react-router';
import { CiStatusChip } from '@/components/shared/ci-status-chip';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RatchetToggleButton } from '@/components/workspace';
import {
  applyRatchetToggleState,
  updateWorkspaceRatchetState,
} from '@/frontend/lib/ratchet-toggle-cache';
import { trpc } from '@/frontend/lib/trpc';
import { cn, formatRelativeTime } from '@/lib/utils';
import {
  deriveWorkspaceSidebarStatus,
  getWorkspaceActivityTooltip,
  getWorkspacePrTooltipSuffix,
  type WorkspaceSidebarStatus,
} from '@/shared/workspace-sidebar-status';
import type { WorkspaceListItem } from './use-workspace-list-state';

// =============================================================================
// Creating Workspace Item
// =============================================================================

export function CreatingWorkspaceItem() {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton size="lg" className="h-auto px-2 py-2 cursor-default">
        <div className="flex items-center gap-1.5 w-full min-w-0">
          {/* Invisible drag handle spacer to match layout */}
          <div className="w-4 shrink-0" aria-hidden="true" />
          <div className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-foreground/40 border-t-foreground" />
          <span className="truncate text-sm">Creating...</span>
        </div>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// =============================================================================
// Active Workspace Item
// =============================================================================

interface ActiveWorkspaceItemProps {
  workspace: WorkspaceListItem;
  isActive: boolean;
  selectedProjectId?: string;
  selectedProjectSlug: string;
  onArchiveRequest: (workspace: WorkspaceListItem) => void;
  disableRatchetAnimation?: boolean;
  needsAttention: (workspaceId: string) => boolean;
  clearAttention: (workspaceId: string) => void;
  sortableRef?: (node: HTMLElement | null) => void;
  sortableStyle?: React.CSSProperties;
  sortableAttributes?: ReturnType<typeof useSortable>['attributes'];
  sortableListeners?: ReturnType<typeof useSortable>['listeners'];
  isDragging?: boolean;
  hideDragHandle?: boolean;
}

export function ActiveWorkspaceItem({
  workspace,
  isActive,
  selectedProjectId,
  selectedProjectSlug,
  onArchiveRequest,
  disableRatchetAnimation,
  needsAttention,
  clearAttention,
  sortableRef,
  sortableStyle,
  sortableAttributes,
  sortableListeners,
  isDragging,
  hideDragHandle,
}: ActiveWorkspaceItemProps) {
  const utils = trpc.useUtils();
  const workspaceId = workspace.id;
  const toggleRatcheting = trpc.workspace.toggleRatcheting.useMutation({
    onMutate: ({ enabled }) => {
      if (selectedProjectId) {
        utils.workspace.getProjectSummaryState.setData({ projectId: selectedProjectId }, (old) => {
          if (!old) {
            return old;
          }
          return {
            ...old,
            workspaces: updateWorkspaceRatchetState(old.workspaces, workspaceId, enabled),
          };
        });
        utils.workspace.listWithKanbanState.setData({ projectId: selectedProjectId }, (old) => {
          if (!old) {
            return old;
          }
          return updateWorkspaceRatchetState(old, workspaceId, enabled);
        });
      }
      utils.workspace.get.setData({ id: workspaceId }, (old) => {
        if (!old) {
          return old;
        }
        return applyRatchetToggleState(old, enabled);
      });
    },
    onError: () => {
      if (selectedProjectId) {
        utils.workspace.getProjectSummaryState.invalidate({ projectId: selectedProjectId });
        utils.workspace.listWithKanbanState.invalidate({ projectId: selectedProjectId });
      }
      utils.workspace.get.invalidate({ id: workspaceId });
    },
    onSuccess: () => {
      if (selectedProjectId) {
        utils.workspace.getProjectSummaryState.invalidate({ projectId: selectedProjectId });
        utils.workspace.listWithKanbanState.invalidate({ projectId: selectedProjectId });
      }
      utils.workspace.get.invalidate({ id: workspaceId });
    },
  });

  const { gitStats: stats } = workspace;
  const ratchetEnabled = workspace.ratchetEnabled ?? true;
  const sidebarStatus = getWorkspaceSidebarStatus(workspace);
  const pendingIndicator = getPendingRequestIndicator(workspace.pendingRequestType ?? null);
  const { showAttentionGlow } = getSidebarAttentionState(
    workspace,
    Boolean(disableRatchetAnimation),
    needsAttention
  );

  return (
    <SidebarMenuItem ref={sortableRef} style={sortableStyle}>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        className={cn(
          'h-auto px-2 py-2',
          isDragging && 'opacity-50 bg-sidebar-accent',
          showAttentionGlow && 'waiting-pulse'
        )}
      >
        <div className="flex w-full min-w-0 items-center gap-1.5">
          {/* Drag handle - outside Link to prevent navigation */}
          {!hideDragHandle && sortableAttributes && sortableListeners && (
            <button
              type="button"
              className="w-4 shrink-0 flex justify-center cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground bg-transparent border-none p-0"
              aria-label="Drag to reorder"
              {...sortableAttributes}
              {...sortableListeners}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <GripVertical className="h-3 w-3" />
            </button>
          )}

          <Link
            to={`/projects/${selectedProjectSlug}/workspaces/${workspace.id}`}
            onClick={() => clearAttention(workspace.id)}
            className="flex flex-1 min-w-0 items-center gap-1.5"
          >
            {/* Status dot + ratchet toggle */}
            <div className="w-5 shrink-0 flex flex-col items-center gap-1.5 self-start mt-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  {pendingIndicator ? (
                    <span
                      className={cn(
                        'flex h-3.5 w-3.5 items-center justify-center',
                        pendingIndicator.className
                      )}
                    >
                      <pendingIndicator.icon className="h-3.5 w-3.5" />
                    </span>
                  ) : (
                    <span
                      className={cn('h-2 w-2 rounded-full', getStatusDotClass(sidebarStatus))}
                    />
                  )}
                </TooltipTrigger>
                <TooltipContent side="right">
                  {pendingIndicator
                    ? pendingIndicator.tooltip
                    : getWorkspaceActivityTooltip(sidebarStatus.activityState)}
                </TooltipContent>
              </Tooltip>
              <RatchetToggleButton
                enabled={ratchetEnabled}
                state={workspace.ratchetState}
                animated={workspace.ratchetButtonAnimated ?? false}
                className="h-5 w-5 shrink-0"
                disabled={toggleRatcheting.isPending}
                stopPropagation
                onToggle={(enabled) => {
                  toggleRatcheting.mutate({ workspaceId, enabled });
                }}
              />
              {workspace.runScriptStatus === 'RUNNING' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Play className="h-3 w-3 text-green-500 fill-green-500 animate-pulse" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="right">Dev server running</TooltipContent>
                </Tooltip>
              )}
            </div>

            <div className="min-w-0 flex-1 space-y-0 self-start">
              {/* Row 1: name + timestamp + archive */}
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium text-sm leading-tight flex-1 min-w-0">
                  {workspace.name}
                </span>
                {workspace.lastActivityAt && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelativeTime(workspace.lastActivityAt)}
                  </span>
                )}
                {/* Archive button */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onArchiveRequest(workspace);
                      }}
                      className={cn(
                        'shrink-0 h-6 w-6 flex items-center justify-center rounded transition-opacity',
                        workspace.prState === 'MERGED'
                          ? 'opacity-100 text-emerald-700 dark:text-emerald-300 bg-emerald-500/15 hover:bg-emerald-500/25'
                          : workspace.prState === 'CLOSED'
                            ? 'opacity-100 text-yellow-500 hover:text-yellow-400 hover:bg-yellow-500/10'
                            : 'opacity-0 group-hover/menu-item:opacity-100 text-muted-foreground hover:text-foreground hover:bg-sidebar-accent'
                      )}
                    >
                      <Archive className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Archive</TooltipContent>
                </Tooltip>
              </div>

              {/* Row 2: branch name */}
              {workspace.branchName && (
                <div className="truncate text-[11px] leading-tight text-muted-foreground font-mono">
                  {workspace.branchName}
                </div>
              )}

              {/* Row 3: files changed + deltas + PR */}
              <WorkspaceMetaRow workspace={workspace} stats={stats} />
            </div>
          </Link>
        </div>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// =============================================================================
// Helper Components
// =============================================================================

function WorkspaceMetaRow({
  workspace,
  stats,
}: {
  workspace: WorkspaceListItem;
  stats: WorkspaceListItem['gitStats'];
}) {
  const hasStats = Boolean(stats && (stats.additions > 0 || stats.deletions > 0));
  const sidebarStatus = getWorkspaceSidebarStatus(workspace);
  const showPR = Boolean(workspace.prNumber && workspace.prState !== 'NONE' && workspace.prUrl);
  const showCI = sidebarStatus.ciState !== 'NONE';
  if (!(hasStats || showPR || showCI)) {
    return null;
  }

  const additionsText = hasStats && stats?.additions ? `+${stats.additions}` : '';
  const deletionsText = hasStats && stats?.deletions ? `-${stats.deletions}` : '';

  return (
    <div className="flex items-center gap-x-1.5 text-xs text-muted-foreground">
      <div className="min-w-0 flex-1">
        <WorkspaceCiBadge workspace={workspace} sidebarStatus={sidebarStatus} />
      </div>
      <span className="shrink-0 text-right tabular-nums text-green-600 dark:text-green-400">
        {additionsText}
      </span>
      <span className="shrink-0 text-left tabular-nums text-red-600 dark:text-red-400">
        {deletionsText}
      </span>
      {showPR && <WorkspacePrButton workspace={workspace} />}
    </div>
  );
}

function WorkspaceCiBadge({
  workspace,
  sidebarStatus,
}: {
  workspace: WorkspaceListItem;
  sidebarStatus: WorkspaceSidebarStatus;
}) {
  if (sidebarStatus.ciState === 'NONE') {
    return <span className="truncate" aria-hidden="true" />;
  }

  return (
    <CiStatusChip
      ciState={sidebarStatus.ciState}
      prState={workspace.prState ?? null}
      size="sm"
      className="max-w-full truncate"
    />
  );
}

function WorkspacePrButton({ workspace }: { workspace: WorkspaceListItem }) {
  const tooltipSuffix = getPrTooltipSuffix(workspace);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (workspace.prUrl) {
              window.open(workspace.prUrl, '_blank', 'noopener,noreferrer');
            }
          }}
          className={cn(
            'flex shrink-0 items-center gap-1 text-xs hover:opacity-80 transition-opacity p-0',
            workspace.prState === 'MERGED'
              ? 'text-green-500'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <GitPullRequest className="h-3 w-3" />
          <span>#{workspace.prNumber}</span>
          {workspace.prState === 'MERGED' && <CheckCircle2 className="h-3 w-3 text-green-500" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        <p>
          PR #{workspace.prNumber}
          {tooltipSuffix}
        </p>
        <p className="text-xs text-muted-foreground">Click to open on GitHub</p>
      </TooltipContent>
    </Tooltip>
  );
}

function getPrTooltipSuffix(workspace: WorkspaceListItem) {
  const ciState = getWorkspaceSidebarStatus(workspace).ciState;
  return getWorkspacePrTooltipSuffix(ciState, workspace.prState ?? null);
}

// =============================================================================
// Helper Functions
// =============================================================================

function getWorkspaceSidebarStatus(workspace: WorkspaceListItem): WorkspaceSidebarStatus {
  return (
    workspace.sidebarStatus ??
    deriveWorkspaceSidebarStatus({
      isWorking: workspace.isWorking,
      prUrl: workspace.prUrl ?? null,
      prState: workspace.prState ?? null,
      prCiStatus: workspace.prCiStatus ?? null,
      ratchetState: workspace.ratchetState ?? null,
    })
  );
}

function getSidebarAttentionState(
  workspace: WorkspaceListItem,
  disableAnimation: boolean,
  needsAttention: (id: string) => boolean
): { showAttentionGlow: boolean } {
  const isDone = workspace.cachedKanbanColumn === 'DONE';
  const isRatchetActive = !(disableAnimation || isDone) && Boolean(workspace.ratchetButtonAnimated);

  return {
    showAttentionGlow: needsAttention(workspace.id) && !isRatchetActive,
  };
}

function getStatusDotClass(status: WorkspaceSidebarStatus): string {
  if (status.activityState === 'WORKING') {
    return 'bg-green-500 animate-pulse';
  }
  return 'bg-gray-400';
}

function getPendingRequestIndicator(pendingRequestType: WorkspaceListItem['pendingRequestType']): {
  icon: LucideIcon;
  className: string;
  tooltip: string;
} | null {
  if (!pendingRequestType) {
    return null;
  }

  if (pendingRequestType === 'permission_request') {
    return {
      icon: ShieldAlert,
      className: 'text-orange-600 dark:text-orange-400',
      tooltip: 'Permission needed',
    };
  }

  if (pendingRequestType === 'plan_approval') {
    return {
      icon: FileCheck,
      className: 'text-amber-600 dark:text-amber-400',
      tooltip: 'Plan approval needed',
    };
  }

  return {
    icon: MessageCircleQuestion,
    className: 'text-blue-600 dark:text-blue-400',
    tooltip: 'Question waiting',
  };
}
