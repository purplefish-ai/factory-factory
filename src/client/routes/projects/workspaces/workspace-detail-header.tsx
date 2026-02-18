import {
  AppWindow,
  Archive,
  CheckCircle2,
  CircleDot,
  GitBranch,
  Github,
  GitPullRequest,
  Loader2,
  MoreHorizontal,
  PanelRight,
  Settings2,
  Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { CiStatusChip } from '@/components/shared/ci-status-chip';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  QuickActionsMenu,
  RatchetToggleButton,
  RunScriptButton,
  RunScriptPortBadge,
  useWorkspacePanel,
} from '@/components/workspace';
import { ProviderCliWarning } from '@/frontend/components/provider-cli-warning';
import {
  applyRatchetToggleState,
  updateWorkspaceRatchetState,
} from '@/frontend/lib/ratchet-toggle-cache';
import { trpc } from '@/frontend/lib/trpc';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  EXPLICIT_SESSION_PROVIDER_OPTIONS,
  getWorkspaceDefaultOptionLabel,
  type NewSessionProviderSelection,
  resolveEffectiveSessionProvider,
  resolveProviderSelection,
} from '@/lib/session-provider-selection';
import { cn } from '@/lib/utils';

import { encodeGitHubTreeRef } from './github-branch-url';
import type { useSessionManagement, useWorkspaceData } from './use-workspace-detail';

function ToggleRightPanelButton() {
  const { rightPanelVisible, toggleRightPanel } = useWorkspacePanel();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleRightPanel}
          className="h-9 w-9 md:h-8 md:w-8"
        >
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
      <div className="flex min-w-0 items-center gap-1.5">
        <GitBranch className="h-3.5 w-3.5 md:h-4 md:w-4 text-muted-foreground shrink-0" />
        <h1 className="text-sm md:text-lg font-semibold font-mono truncate">
          {workspace.branchName}
        </h1>
      </div>
    );
  }

  return <h1 className="text-sm md:text-lg font-semibold truncate">{workspace.name}</h1>;
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

function WorkspaceIssueLink({
  workspace,
}: {
  workspace: NonNullable<ReturnType<typeof useWorkspaceData>['workspace']>;
}) {
  if (workspace.linearIssueIdentifier && workspace.linearIssueUrl) {
    return (
      <a
        href={workspace.linearIssueUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-opacity hover:opacity-80"
      >
        <CircleDot className="h-3 w-3 text-violet-500" />
        {workspace.linearIssueIdentifier}
      </a>
    );
  }

  if (workspace.githubIssueNumber && workspace.githubIssueUrl) {
    return (
      <a
        href={workspace.githubIssueUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-opacity hover:opacity-80"
      >
        <CircleDot className="h-3 w-3 text-green-500" />#{workspace.githubIssueNumber}
      </a>
    );
  }

  return null;
}

function WorkspaceCiStatus({
  workspace,
}: {
  workspace: NonNullable<ReturnType<typeof useWorkspaceData>['workspace']>;
}) {
  if (!workspace.prUrl) {
    return null;
  }
  if (!workspace.sidebarStatus) {
    return null;
  }

  return (
    <CiStatusChip ciState={workspace.sidebarStatus.ciState} prState={workspace.prState} size="md" />
  );
}

function WorkspaceBranchLink({
  workspace,
  renderAsMenuItem = false,
}: {
  workspace: NonNullable<ReturnType<typeof useWorkspaceData>['workspace']>;
  renderAsMenuItem?: boolean;
}) {
  const { data: project } = trpc.project.getById.useQuery(
    { id: workspace.projectId },
    { enabled: Boolean(workspace.branchName) }
  );

  const branchUrl =
    workspace.branchName && project?.githubOwner && project?.githubRepo
      ? `https://github.com/${project.githubOwner}/${project.githubRepo}/tree/${encodeGitHubTreeRef(workspace.branchName)}`
      : null;

  if (!branchUrl) {
    return null;
  }

  if (renderAsMenuItem) {
    return (
      <DropdownMenuItem asChild>
        <a href={branchUrl} target="_blank" rel="noopener noreferrer">
          <Github className="h-4 w-4" />
          Open branch on GitHub
        </a>
      </DropdownMenuItem>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="ghost" size="icon" className="h-8 w-8">
          <a
            href={branchUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open branch on GitHub"
          >
            <Github className="h-4 w-4" />
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Open branch on GitHub</TooltipContent>
    </Tooltip>
  );
}

function RatchetingToggle({
  workspace,
  workspaceId,
  renderAsMenuItem = false,
}: {
  workspace: NonNullable<ReturnType<typeof useWorkspaceData>['workspace']>;
  workspaceId: string;
  renderAsMenuItem?: boolean;
}) {
  const utils = trpc.useUtils();
  const toggleRatcheting = trpc.workspace.toggleRatcheting.useMutation({
    onMutate: ({ enabled }) => {
      utils.workspace.get.setData({ id: workspaceId }, (old) => {
        if (!old) {
          return old;
        }
        return applyRatchetToggleState(old, enabled);
      });
      utils.workspace.listWithKanbanState.setData({ projectId: workspace.projectId }, (old) => {
        if (!old) {
          return old;
        }
        return updateWorkspaceRatchetState(old, workspaceId, enabled);
      });
      utils.workspace.getProjectSummaryState.setData({ projectId: workspace.projectId }, (old) => {
        if (!old) {
          return old;
        }
        return {
          ...old,
          workspaces: updateWorkspaceRatchetState(old.workspaces, workspaceId, enabled),
        };
      });
    },
    onError: () => {
      utils.workspace.get.invalidate({ id: workspaceId });
      utils.workspace.listWithKanbanState.invalidate({ projectId: workspace.projectId });
      utils.workspace.getProjectSummaryState.invalidate({ projectId: workspace.projectId });
    },
    onSuccess: () => {
      utils.workspace.get.invalidate({ id: workspaceId });
      utils.workspace.listWithKanbanState.invalidate({ projectId: workspace.projectId });
      utils.workspace.getProjectSummaryState.invalidate({ projectId: workspace.projectId });
    },
  });

  const workspaceRatchetEnabled = workspace.ratchetEnabled ?? true;

  if (renderAsMenuItem) {
    return (
      <DropdownMenuItem
        onSelect={() => {
          toggleRatcheting.mutate({ workspaceId, enabled: !workspaceRatchetEnabled });
        }}
        disabled={toggleRatcheting.isPending}
      >
        {toggleRatcheting.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Zap className="h-4 w-4" />
        )}
        {workspaceRatchetEnabled ? 'Turn off auto-fix' : 'Turn on auto-fix'}
      </DropdownMenuItem>
    );
  }

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

function WorkspaceProviderSettings({
  workspace,
  workspaceId,
  open,
  onOpenChange,
  showTrigger = true,
}: {
  workspace: NonNullable<ReturnType<typeof useWorkspaceData>['workspace']>;
  workspaceId: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [defaultProvider, setDefaultProvider] = useState<NewSessionProviderSelection>(
    resolveProviderSelection(workspace.defaultSessionProvider)
  );
  const [ratchetProvider, setRatchetProvider] = useState<NewSessionProviderSelection>(
    resolveProviderSelection(workspace.ratchetSessionProvider)
  );
  const { data: userSettings } = trpc.userSettings.get.useQuery();
  const utils = trpc.useUtils();

  const updateProviderDefaults = trpc.workspace.updateProviderDefaults.useMutation({
    onSuccess: () => {
      utils.workspace.get.invalidate({ id: workspaceId });
      utils.workspace.listWithKanbanState.invalidate({ projectId: workspace.projectId });
      utils.workspace.getProjectSummaryState.invalidate({ projectId: workspace.projectId });
      setDialogOpen(false);
    },
  });

  const isOpenControlled = open !== undefined;
  const dialogOpen = isOpenControlled ? open : uncontrolledOpen;
  const setDialogOpen = (nextOpen: boolean) => {
    if (!isOpenControlled) {
      setUncontrolledOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };

  useEffect(() => {
    if (!dialogOpen) {
      return;
    }
    setDefaultProvider(resolveProviderSelection(workspace.defaultSessionProvider));
    setRatchetProvider(resolveProviderSelection(workspace.ratchetSessionProvider));
  }, [dialogOpen, workspace.defaultSessionProvider, workspace.ratchetSessionProvider]);

  const currentDefaultProvider = resolveProviderSelection(workspace.defaultSessionProvider);
  const currentRatchetProvider = resolveProviderSelection(workspace.ratchetSessionProvider);
  const isDirty =
    defaultProvider !== currentDefaultProvider || ratchetProvider !== currentRatchetProvider;
  const userDefaultProvider = userSettings?.defaultSessionProvider;
  const defaultWorkspaceLabel = getWorkspaceDefaultOptionLabel(
    'WORKSPACE_DEFAULT',
    userDefaultProvider
  );
  const ratchetWorkspaceLabel = getWorkspaceDefaultOptionLabel(
    defaultProvider,
    userDefaultProvider
  );

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      {showTrigger && (
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 md:h-8 md:w-8"
                aria-label="Provider settings"
              >
                <Settings2 className="h-4 w-4" />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent>Provider settings</TooltipContent>
        </Tooltip>
      )}
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Session Provider Defaults</DialogTitle>
          <DialogDescription>
            Configure workspace defaults and ratchet provider behavior.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="workspace-default-provider">Default Session Provider</Label>
            <Select
              value={defaultProvider}
              onValueChange={(value) => {
                setDefaultProvider(resolveProviderSelection(value));
              }}
            >
              <SelectTrigger id="workspace-default-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="WORKSPACE_DEFAULT">{defaultWorkspaceLabel}</SelectItem>
                {EXPLICIT_SESSION_PROVIDER_OPTIONS.map((option) => (
                  <SelectItem key={`default-${option.value}`} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ProviderCliWarning
              provider={resolveEffectiveSessionProvider(defaultProvider, userDefaultProvider)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="workspace-ratchet-provider">Ratchet Session Provider</Label>
            <Select
              value={ratchetProvider}
              onValueChange={(value) => {
                setRatchetProvider(resolveProviderSelection(value));
              }}
            >
              <SelectTrigger id="workspace-ratchet-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="WORKSPACE_DEFAULT">{ratchetWorkspaceLabel}</SelectItem>
                {EXPLICIT_SESSION_PROVIDER_OPTIONS.map((option) => (
                  <SelectItem key={`ratchet-${option.value}`} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ProviderCliWarning
              provider={resolveEffectiveSessionProvider(
                ratchetProvider === 'WORKSPACE_DEFAULT' ? defaultProvider : ratchetProvider,
                userDefaultProvider
              )}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              updateProviderDefaults.mutate({
                workspaceId,
                defaultSessionProvider: defaultProvider,
                ratchetSessionProvider: ratchetProvider,
              });
            }}
            disabled={!isDirty || updateProviderDefaults.isPending}
          >
            {updateProviderDefaults.isPending ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OpenInIdeAction({
  workspaceId,
  hasWorktreePath,
  availableIdes,
  preferredIde,
  openInIde,
  renderAsMenuItem = false,
}: {
  workspaceId: string;
  hasWorktreePath: boolean;
  availableIdes: ReturnType<typeof useSessionManagement>['availableIdes'];
  preferredIde: ReturnType<typeof useSessionManagement>['preferredIde'];
  openInIde: ReturnType<typeof useSessionManagement>['openInIde'];
  renderAsMenuItem?: boolean;
}) {
  if (availableIdes.length === 0) {
    return null;
  }

  const preferredIdeName = availableIdes.find((ide) => ide.id === preferredIde)?.name ?? 'IDE';
  const disabled = openInIde.isPending || !hasWorktreePath;

  if (renderAsMenuItem) {
    return (
      <DropdownMenuItem
        onSelect={() => {
          openInIde.mutate({ id: workspaceId });
        }}
        disabled={disabled}
      >
        {openInIde.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <AppWindow className="h-4 w-4" />
        )}
        Open in {preferredIdeName}
      </DropdownMenuItem>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 md:h-8 md:w-8"
          onClick={() => openInIde.mutate({ id: workspaceId })}
          disabled={disabled}
        >
          {openInIde.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <AppWindow className="h-4 w-4" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Open in {preferredIdeName}</TooltipContent>
    </Tooltip>
  );
}

function ArchiveActionButton({
  workspace,
  archivePending,
  onArchiveRequest,
  renderAsMenuItem = false,
}: {
  workspace: NonNullable<ReturnType<typeof useWorkspaceData>['workspace']>;
  archivePending: boolean;
  onArchiveRequest: () => void;
  renderAsMenuItem?: boolean;
}) {
  if (renderAsMenuItem) {
    return (
      <DropdownMenuItem
        onSelect={onArchiveRequest}
        disabled={archivePending}
        className={cn(
          workspace.prState === 'MERGED'
            ? ''
            : 'text-destructive focus:text-destructive dark:text-destructive'
        )}
      >
        {archivePending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Archive className="h-4 w-4" />
        )}
        {archivePending ? 'Archiving...' : 'Archive workspace'}
      </DropdownMenuItem>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={workspace.prState === 'MERGED' ? 'default' : 'ghost'}
          size="icon"
          className={cn(
            'h-9 w-9 md:h-8 md:w-8',
            workspace.prState === 'MERGED' ? '' : 'hover:bg-destructive/10 hover:text-destructive'
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
  );
}

function WorkspaceQuickActionsSubmenu({
  handleQuickAction,
  disabled,
}: {
  handleQuickAction: ReturnType<typeof useSessionManagement>['handleQuickAction'];
  disabled: boolean;
}) {
  const { data: quickActions, isLoading } = trpc.session.listQuickActions.useQuery();
  const agentActions = quickActions?.filter((action) => action.type === 'agent') ?? [];

  if (isLoading) {
    return (
      <DropdownMenuItem disabled>
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading quick actions...
      </DropdownMenuItem>
    );
  }

  if (agentActions.length === 0) {
    return null;
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        <Zap className="h-4 w-4" />
        Quick actions
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-56">
          {agentActions.map((action) => (
            <DropdownMenuItem
              key={action.id}
              onSelect={() => {
                if (action.content) {
                  handleQuickAction(action.name, action.content);
                }
              }}
              disabled={disabled || !action.content}
            >
              {action.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

function WorkspaceHeaderOverflowMenu({
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
}: {
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
}) {
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);

  return (
    <>
      <WorkspaceProviderSettings
        workspace={workspace}
        workspaceId={workspaceId}
        open={providerSettingsOpen}
        onOpenChange={setProviderSettingsOpen}
        showTrigger={false}
      />
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="More actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel>Workspace actions</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setProviderSettingsOpen(true)}>
            <Settings2 className="h-4 w-4" />
            Provider settings
          </DropdownMenuItem>
          <RatchetingToggle workspace={workspace} workspaceId={workspaceId} renderAsMenuItem />
          <WorkspaceBranchLink workspace={workspace} renderAsMenuItem />
          <OpenInIdeAction
            workspaceId={workspaceId}
            hasWorktreePath={Boolean(workspace.worktreePath)}
            availableIdes={availableIdes}
            preferredIde={preferredIde}
            openInIde={openInIde}
            renderAsMenuItem
          />
          <WorkspaceQuickActionsSubmenu
            handleQuickAction={handleQuickAction}
            disabled={running || isCreatingSession}
          />
          <DropdownMenuSeparator />
          <ArchiveActionButton
            workspace={workspace}
            archivePending={archivePending}
            onArchiveRequest={onArchiveRequest}
            renderAsMenuItem
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
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
  const isMobile = useIsMobile();

  return (
    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-1 md:gap-2 px-2 py-1.5 md:px-4 md:py-2 border-b">
      <div className="flex flex-wrap items-center gap-2 md:gap-3 min-w-0">
        <WorkspaceTitle workspace={workspace} />
        <WorkspaceIssueLink workspace={workspace} />
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
      <div
        className={cn(
          'flex items-center gap-1 shrink-0 md:justify-end',
          !isMobile && 'flex-wrap gap-0.5 md:gap-1'
        )}
      >
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
              handleQuickAction={handleQuickAction}
              running={running}
              isCreatingSession={isCreatingSession}
            />
          </>
        ) : (
          <>
            <WorkspaceProviderSettings workspace={workspace} workspaceId={workspaceId} />
            <RatchetingToggle workspace={workspace} workspaceId={workspaceId} />
            <WorkspaceBranchLink workspace={workspace} />
            <QuickActionsMenu
              onExecuteAgent={(action) => {
                if (action.content) {
                  handleQuickAction(action.name, action.content);
                }
              }}
              disabled={running || isCreatingSession}
            />
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
    </div>
  );
}
