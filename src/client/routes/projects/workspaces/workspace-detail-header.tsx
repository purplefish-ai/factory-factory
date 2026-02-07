import {
  AppWindow,
  Archive,
  CheckCircle2,
  Circle,
  GitBranch,
  GitPullRequest,
  Loader2,
  type LucideIcon,
  PanelRight,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  QuickActionsMenu,
  RatchetToggleButton,
  RunScriptButton,
  RunScriptPortBadge,
  useWorkspacePanel,
} from '@/components/workspace';
import { cn } from '@/lib/utils';
import {
  deriveWorkspaceSidebarStatus,
  getWorkspaceCiLabel,
  getWorkspaceCiTooltip,
} from '@/shared/workspace-sidebar-status';
import { trpc } from '../../../../frontend/lib/trpc';

import type { useSessionManagement, useWorkspaceData } from './use-workspace-detail';

function ToggleRightPanelButton() {
  const { rightPanelVisible, toggleRightPanel } = useWorkspacePanel();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={toggleRightPanel} className="h-8 w-8">
          <PanelRight className={cn('h-4 w-4', rightPanelVisible && 'text-primary')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{rightPanelVisible ? 'Hide right panel' : 'Show right panel'}</TooltipContent>
    </Tooltip>
  );
}

function WorkspaceTitle({
  workspace,
}: {
  workspace: NonNullable<ReturnType<typeof useWorkspaceData>['workspace']>;
}) {
  if (workspace.branchName) {
    return (
      <div className="flex items-center gap-2">
        <GitBranch className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-lg font-semibold font-mono">{workspace.branchName}</h1>
      </div>
    );
  }

  return <h1 className="text-lg font-semibold">{workspace.name}</h1>;
}

function WorkspacePrAction({
  workspace,
  hasChanges,
  running,
  isCreatingSession,
  handleQuickAction,
}: {
  workspace: NonNullable<ReturnType<typeof useWorkspaceData>['workspace']>;
  hasChanges?: boolean;
  running: boolean;
  isCreatingSession: boolean;
  handleQuickAction: ReturnType<typeof useSessionManagement>['handleQuickAction'];
}) {
  if (hasChanges && !running && (workspace.prState === 'NONE' || workspace.prState === 'CLOSED')) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 text-xs px-2"
            disabled={isCreatingSession}
            onClick={() =>
              handleQuickAction(
                'Create Pull Request',
                'Create a pull request for the current branch using the GitHub CLI (gh). Include a clear title and description summarizing the changes.'
              )
            }
          >
            <GitPullRequest className="h-3 w-3" />
            Create PR
          </Button>
        </TooltipTrigger>
        <TooltipContent>Create a pull request for this branch</TooltipContent>
      </Tooltip>
    );
  }

  if (
    workspace.prUrl &&
    workspace.prNumber &&
    workspace.prState !== 'NONE' &&
    workspace.prState !== 'CLOSED'
  ) {
    return (
      <a
        href={workspace.prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={`flex items-center gap-1 text-xs hover:opacity-80 transition-opacity ${
          workspace.prState === 'MERGED'
            ? 'text-green-500'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <GitPullRequest className="h-3 w-3" />#{workspace.prNumber}
        {workspace.prState === 'MERGED' && <CheckCircle2 className="h-3 w-3 text-green-500" />}
      </a>
    );
  }

  return null;
}

function WorkspaceCiStatus({
  workspace,
  running,
}: {
  workspace: NonNullable<ReturnType<typeof useWorkspaceData>['workspace']>;
  running: boolean;
}) {
  if (!workspace.prUrl || workspace.prState !== 'OPEN') {
    return null;
  }

  const sidebarStatus =
    workspace.sidebarStatus ??
    deriveWorkspaceSidebarStatus({
      isWorking: running,
      prUrl: workspace.prUrl,
      prState: workspace.prState,
      prCiStatus: workspace.prCiStatus,
      ratchetState: workspace.ratchetState,
    });

  const ciState = sidebarStatus.ciState;
  if (ciState === 'NONE') {
    return null;
  }

  const statusConfig = getHeaderCiStatusConfig(ciState);
  const { Icon } = statusConfig;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            'flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium',
            statusConfig.className
          )}
        >
          <Icon className={cn('h-3 w-3', ciState === 'RUNNING' && 'animate-pulse')} />
          <span>{getWorkspaceCiLabel(ciState)}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>{getWorkspaceCiTooltip(ciState, workspace.prState)}</TooltipContent>
    </Tooltip>
  );
}

function getHeaderCiStatusConfig(
  ciState: ReturnType<typeof deriveWorkspaceSidebarStatus>['ciState']
): { className: string; Icon: LucideIcon } {
  switch (ciState) {
    case 'PASSING':
      return {
        className: 'bg-green-100 dark:bg-green-950 text-green-700 dark:text-green-300',
        Icon: CheckCircle2,
      };
    case 'FAILING':
      return {
        className: 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-300',
        Icon: XCircle,
      };
    case 'RUNNING':
      return {
        className: 'bg-yellow-100 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-300',
        Icon: Circle,
      };
    case 'UNKNOWN':
      return {
        className: 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300',
        Icon: Circle,
      };
    case 'MERGED':
      return {
        className: 'bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-300',
        Icon: CheckCircle2,
      };
    case 'NONE':
      return {
        className: 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300',
        Icon: Circle,
      };
  }
}

function RatchetingToggle({
  workspace,
  workspaceId,
}: {
  workspace: NonNullable<ReturnType<typeof useWorkspaceData>['workspace']>;
  workspaceId: string;
}) {
  const utils = trpc.useUtils();
  const toggleRatcheting = trpc.workspace.toggleRatcheting.useMutation({
    onSuccess: () => {
      utils.workspace.get.invalidate({ id: workspaceId });
      utils.workspace.listWithKanbanState.invalidate({ projectId: workspace.projectId });
      utils.workspace.getProjectSummaryState.invalidate({ projectId: workspace.projectId });
    },
  });

  const workspaceRatchetEnabled = workspace.ratchetEnabled ?? true;

  return (
    <RatchetToggleButton
      enabled={workspaceRatchetEnabled}
      state={workspace.ratchetState}
      animated={workspace.ratchetButtonAnimated ?? false}
      disabled={toggleRatcheting.isPending}
      onToggle={(enabled) => {
        toggleRatcheting.mutate({ workspaceId, enabled });
      }}
    />
  );
}

interface WorkspaceHeaderProps {
  workspace: NonNullable<ReturnType<typeof useWorkspaceData>['workspace']>;
  workspaceId: string;
  availableIdes: ReturnType<typeof useSessionManagement>['availableIdes'];
  preferredIde: ReturnType<typeof useSessionManagement>['preferredIde'];
  openInIde: ReturnType<typeof useSessionManagement>['openInIde'];
  archivePending: boolean;
  onArchiveRequest: () => void;
  handleQuickAction: ReturnType<typeof useSessionManagement>['handleQuickAction'];
  running: boolean;
  isCreatingSession: boolean;
  hasChanges?: boolean;
}

export function WorkspaceHeader({
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
  return (
    <div className="flex items-center justify-between px-4 py-2 border-b">
      <div className="flex items-center gap-3">
        <WorkspaceTitle workspace={workspace} />
        <RunScriptPortBadge workspaceId={workspaceId} />
        <WorkspacePrAction
          workspace={workspace}
          hasChanges={hasChanges}
          running={running}
          isCreatingSession={isCreatingSession}
          handleQuickAction={handleQuickAction}
        />
        <WorkspaceCiStatus workspace={workspace} running={running} />
      </div>
      <div className="flex items-center gap-1">
        <RatchetingToggle workspace={workspace} workspaceId={workspaceId} />
        <QuickActionsMenu
          onExecuteAgent={(action) => {
            if (action.content) {
              handleQuickAction(action.name, action.content);
            }
          }}
          disabled={running || isCreatingSession}
        />
        <RunScriptButton workspaceId={workspaceId} />
        {availableIdes.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => openInIde.mutate({ id: workspaceId })}
                disabled={openInIde.isPending || !workspace.worktreePath}
              >
                {openInIde.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <AppWindow className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Open in {availableIdes.find((ide) => ide.id === preferredIde)?.name ?? 'IDE'}
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={workspace.prState === 'MERGED' ? 'default' : 'ghost'}
              size="icon"
              className={cn(
                'h-8 w-8',
                workspace.prState === 'MERGED'
                  ? ''
                  : 'hover:bg-destructive/10 hover:text-destructive'
              )}
              onClick={onArchiveRequest}
              disabled={archivePending}
            >
              {archivePending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Archive className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{archivePending ? 'Archiving...' : 'Archive'}</TooltipContent>
        </Tooltip>
        <ToggleRightPanelButton />
      </div>
    </div>
  );
}
