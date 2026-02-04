import {
  AppWindow,
  Archive,
  CheckCircle2,
  Circle,
  GitBranch,
  GitPullRequest,
  Loader2,
  PanelRight,
  Wrench,
  XCircle,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  QuickActionsMenu,
  RunScriptButton,
  RunScriptPortBadge,
  useWorkspacePanel,
} from '@/components/workspace';
import { cn } from '@/lib/utils';
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

const CI_STATUS_CONFIG = {
  SUCCESS: {
    label: 'CI Passing',
    tooltip: 'All CI checks are passing',
    className: 'bg-green-100 dark:bg-green-950 text-green-700 dark:text-green-300',
    Icon: CheckCircle2,
  },
  FAILURE: {
    label: 'CI Failing',
    tooltip: 'Some CI checks are failing',
    className: 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-300',
    Icon: XCircle,
  },
  PENDING: {
    label: 'CI Running',
    tooltip: 'CI checks are currently running',
    className: 'bg-yellow-100 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-300',
    Icon: Circle,
  },
  UNKNOWN: {
    label: 'CI Unknown',
    tooltip: 'CI status not yet determined',
    className: 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300',
    Icon: Circle,
  },
} as const;

function WorkspaceCiStatus({
  workspace,
}: {
  workspace: NonNullable<ReturnType<typeof useWorkspaceData>['workspace']>;
}) {
  if (!workspace.prUrl || workspace.prState !== 'OPEN') {
    return null;
  }

  const statusConfig = CI_STATUS_CONFIG[workspace.prCiStatus];
  if (!statusConfig) {
    return null;
  }

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
          <Icon className={cn('h-3 w-3', workspace.prCiStatus === 'PENDING' && 'animate-pulse')} />
          <span>{statusConfig.label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>{statusConfig.tooltip}</TooltipContent>
    </Tooltip>
  );
}

const RATCHET_STATE_LABELS = {
  IDLE: 'Idle',
  CI_RUNNING: 'CI Running',
  CI_FAILED: 'CI Failed',
  MERGE_CONFLICT: 'Conflicts',
  REVIEW_PENDING: 'Reviews',
  READY: 'Ready',
  MERGED: 'Merged',
} as const;

function RatchetingToggle({
  workspace,
  workspaceId,
}: {
  workspace: NonNullable<ReturnType<typeof useWorkspaceData>['workspace']>;
  workspaceId: string;
}) {
  const utils = trpc.useUtils();
  const { data: userSettings } = trpc.userSettings.get.useQuery();
  const toggleRatcheting = trpc.workspace.toggleRatcheting.useMutation({
    onSuccess: () => {
      utils.workspace.get.invalidate({ id: workspaceId });
    },
  });

  const globalRatchetEnabled = userSettings?.ratchetEnabled ?? false;
  const workspaceRatchetEnabled = workspace.ratchetEnabled ?? true;
  const isDisabled = !globalRatchetEnabled;

  const stateLabel = RATCHET_STATE_LABELS[workspace.ratchetState] ?? workspace.ratchetState;

  const tooltipContent = isDisabled
    ? 'Ratcheting is disabled globally. Enable it in Admin Settings to use workspace-level controls.'
    : workspaceRatchetEnabled
      ? `Ratcheting enabled (${stateLabel}) - Click to disable auto-fixing for this workspace`
      : `Ratcheting disabled (${stateLabel}) - Click to enable auto-fixing for this workspace`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-2 px-2 py-0.5 rounded text-xs">
          <Wrench className="h-3 w-3 text-muted-foreground" />
          <span className="text-muted-foreground">{stateLabel}</span>
          <Switch
            checked={workspaceRatchetEnabled}
            disabled={isDisabled || toggleRatcheting.isPending}
            onCheckedChange={(checked) => {
              toggleRatcheting.mutate({ workspaceId, enabled: checked });
            }}
            className="h-4 w-7 data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted"
          />
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{tooltipContent}</TooltipContent>
    </Tooltip>
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
        <WorkspaceCiStatus workspace={workspace} />
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
