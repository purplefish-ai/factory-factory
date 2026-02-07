import type { useSortable } from '@dnd-kit/sortable';
import { Archive, CheckCircle2, GitPullRequest, GripVertical } from 'lucide-react';
import { Link } from 'react-router';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RatchetToggleButton } from '@/components/workspace';
import { cn, formatRelativeTime } from '@/lib/utils';
import { trpc } from '../lib/trpc';
import type { WorkspaceListItem } from './use-workspace-list-state';

// =============================================================================
// Creating Workspace Item
// =============================================================================

export function CreatingWorkspaceItem() {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton size="lg" className="px-2 cursor-default">
        <div className="flex items-center gap-2 w-full min-w-0">
          <div className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-foreground/40 border-t-foreground" />
          <span className="truncate text-sm">Creating...</span>
        </div>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// =============================================================================
// Archiving Workspace Item
// =============================================================================

interface ArchivingWorkspaceItemProps {
  workspace: WorkspaceListItem;
  selectedProjectSlug: string;
  sortableRef: (node: HTMLElement | null) => void;
  sortableStyle: React.CSSProperties;
}

export function ArchivingWorkspaceItem({
  workspace,
  selectedProjectSlug,
  sortableRef,
  sortableStyle,
}: ArchivingWorkspaceItemProps) {
  return (
    <SidebarMenuItem ref={sortableRef} style={sortableStyle}>
      <SidebarMenuButton asChild className="h-auto px-2 py-2.5 opacity-50 pointer-events-none">
        <Link to={`/projects/${selectedProjectSlug}/workspaces/${workspace.id}`}>
          <div className="flex items-center gap-2 w-full min-w-0">
            <div className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-muted-foreground" />
            <span className="truncate text-sm text-muted-foreground">Archiving...</span>
          </div>
        </Link>
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
  sortableRef: (node: HTMLElement | null) => void;
  sortableStyle: React.CSSProperties;
  sortableAttributes: ReturnType<typeof useSortable>['attributes'];
  sortableListeners: ReturnType<typeof useSortable>['listeners'];
  isDragging: boolean;
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
}: ActiveWorkspaceItemProps) {
  const utils = trpc.useUtils();
  const toggleRatcheting = trpc.workspace.toggleRatcheting.useMutation({
    onSuccess: () => {
      if (selectedProjectId) {
        utils.workspace.getProjectSummaryState.invalidate({ projectId: selectedProjectId });
        utils.workspace.listWithKanbanState.invalidate({ projectId: selectedProjectId });
      }
      utils.workspace.get.invalidate({ id: workspace.id });
    },
  });

  const { gitStats: stats } = workspace;
  const ratchetEnabled = workspace.ratchetEnabled ?? true;
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
          'h-auto px-2 py-2.5',
          isDragging && 'opacity-50 bg-sidebar-accent',
          showAttentionGlow && 'waiting-pulse'
        )}
      >
        <Link
          to={`/projects/${selectedProjectSlug}/workspaces/${workspace.id}`}
          onClick={() => clearAttention(workspace.id)}
        >
          <div className="flex w-full min-w-0 items-start gap-2">
            {/* Drag handle */}
            <button
              type="button"
              className="w-4 shrink-0 flex justify-center mt-2 cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground bg-transparent border-none p-0"
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

            {/* Status dot + ratchet toggle */}
            <div className="w-5 shrink-0 mt-1.5 flex flex-col items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={cn('h-2 w-2 rounded-full', getStatusDotClass(workspace))} />
                </TooltipTrigger>
                <TooltipContent side="right">{getStatusTooltip(workspace)}</TooltipContent>
              </Tooltip>
              <RatchetToggleButton
                enabled={ratchetEnabled}
                state={workspace.ratchetState}
                animated={workspace.ratchetButtonAnimated ?? false}
                className="h-5 w-5 shrink-0"
                disabled={toggleRatcheting.isPending}
                stopPropagation
                onToggle={(enabled) => {
                  toggleRatcheting.mutate({ workspaceId: workspace.id, enabled });
                }}
              />
            </div>

            <div className="min-w-0 flex-1 space-y-0">
              {/* Row 1: name + timestamp + archive */}
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-sm leading-tight flex-1">
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
          </div>
        </Link>
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
  const hasStats = Boolean(
    stats && (stats.additions > 0 || stats.deletions > 0 || stats.total > 0)
  );
  const showPR = Boolean(workspace.prNumber && workspace.prState !== 'NONE' && workspace.prUrl);
  if (!(hasStats || showPR)) {
    return null;
  }

  const filesText = hasStats && stats?.total ? `${stats.total} files` : '';
  const additionsText = hasStats && stats?.additions ? `+${stats.additions}` : '';
  const deletionsText = hasStats && stats?.deletions ? `-${stats.deletions}` : '';

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_40px_40px_72px] items-center gap-x-2 text-xs text-muted-foreground">
      <span className="truncate">{filesText}</span>
      <span className="w-10 text-right tabular-nums text-green-600 dark:text-green-400">
        {additionsText}
      </span>
      <span className="w-10 text-left tabular-nums text-red-600 dark:text-red-400">
        {deletionsText}
      </span>
      {showPR ? <WorkspacePrButton workspace={workspace} /> : <WorkspacePrSpacer />}
    </div>
  );
}

function WorkspacePrSpacer() {
  return <span className="w-[72px]" aria-hidden="true" />;
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
            'flex w-[72px] items-center justify-end gap-1 text-xs hover:opacity-80 transition-opacity p-0',
            workspace.prState === 'MERGED'
              ? 'text-green-500'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <GitPullRequest className="h-3 w-3" />
          <span>#{workspace.prNumber}</span>
          {workspace.prState === 'MERGED' ? (
            <CheckCircle2 className="h-3 w-3 text-green-500" />
          ) : (
            <CheckCircle2 className="h-3 w-3 opacity-0" aria-hidden="true" />
          )}
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
  if (workspace.prState === 'MERGED') {
    return ' · Merged';
  }
  if (workspace.prState === 'CLOSED') {
    return ' · Closed';
  }
  if (workspace.prCiStatus === 'SUCCESS') {
    return ' · CI passed';
  }
  if (workspace.prCiStatus === 'FAILURE') {
    return ' · CI failed';
  }
  if (workspace.prCiStatus === 'PENDING') {
    return ' · CI running';
  }
  return '';
}

// =============================================================================
// Helper Functions
// =============================================================================

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

function getStatusDotClass(workspace: WorkspaceListItem): string {
  if (workspace.isWorking) {
    return 'bg-green-500 animate-pulse';
  }
  if (workspace.prState === 'MERGED') {
    return 'bg-purple-500';
  }
  if (workspace.prCiStatus === 'FAILURE') {
    return 'bg-red-500';
  }
  if (workspace.prCiStatus === 'PENDING') {
    return 'bg-yellow-500 animate-pulse';
  }
  if (workspace.prCiStatus === 'SUCCESS') {
    return 'bg-green-500';
  }
  if (workspace.gitStats?.hasUncommitted) {
    return 'bg-orange-500';
  }
  return 'bg-gray-400';
}

function getStatusTooltip(workspace: WorkspaceListItem): string {
  if (workspace.isWorking) {
    return 'Claude is working';
  }
  if (workspace.prState === 'MERGED') {
    return 'PR merged';
  }
  if (workspace.prCiStatus === 'FAILURE') {
    return 'CI checks failing';
  }
  if (workspace.prCiStatus === 'PENDING') {
    return 'CI checks running';
  }
  if (workspace.prCiStatus === 'SUCCESS') {
    return 'CI checks passing';
  }
  if (workspace.gitStats?.hasUncommitted) {
    return 'Uncommitted changes';
  }
  return 'Ready';
}
