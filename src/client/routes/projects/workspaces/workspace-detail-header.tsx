import {
  AppWindow,
  Archive,
  CheckCircle2,
  ChevronsUpDown,
  CircleDot,
  Github,
  GitPullRequest,
  Loader2,
  MoreHorizontal,
  PanelRight,
  Server,
  Settings2,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  HeaderLeftExtraSlot,
  HeaderLeftStartSlot,
  HeaderRightSlot,
  useAppHeader,
} from '@/client/components/app-header-context';
import { ProjectSelectorDropdown } from '@/client/components/project-selector';
import { ProviderCliWarning } from '@/client/components/provider-cli-warning';
import type { ServerWorkspace } from '@/client/components/use-workspace-list-state';
import { WorkspaceItemContent } from '@/client/components/workspace-item-content';
import {
  applyRatchetToggleState,
  updateWorkspaceRatchetState,
} from '@/client/lib/ratchet-toggle-cache';
import { trpc } from '@/client/lib/trpc';
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  RatchetToggleButton,
  RunScriptButton,
  RunScriptPortBadge,
  useRunScriptLaunch,
  useWorkspacePanel,
} from '@/components/workspace';
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
import { useWorkspaceProjectNavigation } from './use-workspace-project-navigation';

type WorkspaceHeaderWorkspace = NonNullable<ReturnType<typeof useWorkspaceData>['workspace']>;
type WorkspacePrChipProps = {
  prUrl: NonNullable<WorkspaceHeaderWorkspace['prUrl']>;
  prNumber: NonNullable<WorkspaceHeaderWorkspace['prNumber']>;
  isMerged: boolean;
  className?: string;
};

type WorkspaceSwitchGroups = {
  todo: ServerWorkspace[];
  waiting: ServerWorkspace[];
  working: ServerWorkspace[];
  done: ServerWorkspace[];
};

function getCreatedAtMs(value: string | Date): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function byNewest(a: ServerWorkspace, b: ServerWorkspace): number {
  return getCreatedAtMs(b.createdAt) - getCreatedAtMs(a.createdAt);
}

function groupWorkspaceSwitcherItems(workspaces: ServerWorkspace[]): WorkspaceSwitchGroups {
  const todo = workspaces
    .filter(
      (workspace) => workspace.cachedKanbanColumn === 'WAITING' && !workspace.pendingRequestType
    )
    .sort(byNewest);
  const waiting = workspaces
    .filter(
      (workspace) => workspace.cachedKanbanColumn === 'WAITING' && workspace.pendingRequestType
    )
    .sort(byNewest);
  const working = workspaces
    .filter((workspace) => workspace.cachedKanbanColumn === 'WORKING')
    .sort(byNewest);
  const done = workspaces
    .filter((workspace) => workspace.cachedKanbanColumn === 'DONE')
    .sort(byNewest);

  return { todo, waiting, working, done };
}

function getWorkspaceHeaderLabel(
  branchName: string | null | undefined,
  workspaceName: string,
  isMobile: boolean
): string {
  if (!branchName) {
    return workspaceName;
  }

  if (!isMobile) {
    return branchName;
  }

  const slashIndex = branchName.indexOf('/');
  if (slashIndex === -1 || slashIndex === branchName.length - 1) {
    return branchName;
  }

  return branchName.slice(slashIndex + 1);
}

function isWorkspaceMerged(
  workspace: Pick<WorkspaceHeaderWorkspace, 'prState' | 'ratchetState' | 'sidebarStatus'>
): boolean {
  return (
    workspace.prState === 'MERGED' ||
    workspace.ratchetState === 'MERGED' ||
    workspace.sidebarStatus?.ciState === 'MERGED'
  );
}

function hasVisiblePullRequest(
  workspace: Pick<WorkspaceHeaderWorkspace, 'prUrl' | 'prNumber' | 'prState'>
): workspace is {
  prUrl: NonNullable<WorkspaceHeaderWorkspace['prUrl']>;
  prNumber: NonNullable<WorkspaceHeaderWorkspace['prNumber']>;
  prState: WorkspaceHeaderWorkspace['prState'];
} {
  return Boolean(
    workspace.prUrl &&
      workspace.prNumber &&
      workspace.prState !== 'NONE' &&
      workspace.prState !== 'CLOSED'
  );
}

function WorkspacePrChip({ prUrl, prNumber, isMerged, className }: WorkspacePrChipProps) {
  return (
    <a
      href={prUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'flex items-center gap-1 text-xs hover:opacity-80 transition-opacity',
        isMerged ? 'text-green-500' : 'text-muted-foreground hover:text-foreground',
        className
      )}
    >
      <GitPullRequest className="h-3 w-3" />#{prNumber}
      {isMerged && <CheckCircle2 className="h-3 w-3 text-green-500" />}
    </a>
  );
}

function ToggleRightPanelButton() {
  const { rightPanelVisible, toggleRightPanel } = useWorkspacePanel();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleRightPanel}
          className="h-6 w-6 md:h-8 md:w-8"
        >
          <PanelRight
            className={cn('h-3 w-3 md:h-4 md:w-4', rightPanelVisible && 'text-primary')}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{rightPanelVisible ? 'Hide right panel' : 'Show right panel'}</TooltipContent>
    </Tooltip>
  );
}

function WorkspacePrAction({
  workspace,
  hasChanges,
  running,
  isCreatingSession,
  handleQuickAction,
}: {
  workspace: WorkspaceHeaderWorkspace;
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

  if (hasVisiblePullRequest(workspace)) {
    return (
      <WorkspacePrChip
        prUrl={workspace.prUrl}
        prNumber={workspace.prNumber}
        isMerged={isWorkspaceMerged(workspace)}
      />
    );
  }

  return null;
}

function WorkspaceIssueLink({ workspace }: { workspace: WorkspaceHeaderWorkspace }) {
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

function WorkspaceCiStatus({ workspace }: { workspace: WorkspaceHeaderWorkspace }) {
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
  workspace: WorkspaceHeaderWorkspace;
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
  workspace: WorkspaceHeaderWorkspace;
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
        {workspaceRatchetEnabled ? 'Turn off Ratchet' : 'Turn on Ratchet'}
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
  workspace: WorkspaceHeaderWorkspace;
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

function OpenDevAppAction({
  workspaceId,
  renderAsMenuItem = false,
}: {
  workspaceId: string;
  renderAsMenuItem?: boolean;
}) {
  const launchInfo = useRunScriptLaunch(workspaceId);
  if (!launchInfo) {
    return null;
  }

  if (renderAsMenuItem) {
    return (
      <DropdownMenuItem asChild>
        <a href={launchInfo.href} target="_blank" rel="noopener noreferrer">
          <Server className="h-4 w-4" />
          Open dev app
        </a>
      </DropdownMenuItem>
    );
  }

  return null;
}

function ArchiveActionButton({
  workspace,
  archivePending,
  onArchiveRequest,
  renderAsMenuItem = false,
}: {
  workspace: WorkspaceHeaderWorkspace;
  archivePending: boolean;
  onArchiveRequest: () => void;
  renderAsMenuItem?: boolean;
}) {
  const merged = isWorkspaceMerged(workspace);

  if (renderAsMenuItem) {
    return (
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => {
            onArchiveRequest();
          });
        }}
        disabled={archivePending}
        className={cn(
          merged ? '' : 'text-destructive focus:text-destructive dark:text-destructive'
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
          variant={merged ? 'default' : 'ghost'}
          size="icon"
          className={cn(
            'h-9 w-9 md:h-8 md:w-8',
            merged ? '' : 'hover:bg-destructive/10 hover:text-destructive'
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

function WorkspaceHeaderOverflowMenu({
  workspace,
  workspaceId,
  availableIdes,
  preferredIde,
  openInIde,
  archivePending,
  onArchiveRequest,
}: {
  workspace: WorkspaceHeaderWorkspace;
  workspaceId: string;
  availableIdes: ReturnType<typeof useSessionManagement>['availableIdes'];
  preferredIde: ReturnType<typeof useSessionManagement>['preferredIde'];
  openInIde: ReturnType<typeof useSessionManagement>['openInIde'];
  archivePending: boolean;
  onArchiveRequest: () => void;
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
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 md:h-9 md:w-9"
                aria-label="More actions"
              >
                <MoreHorizontal className="h-3 w-3 md:h-4 md:w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel>Workspace actions</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              requestAnimationFrame(() => {
                setProviderSettingsOpen(true);
              });
            }}
          >
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
          <OpenDevAppAction workspaceId={workspaceId} renderAsMenuItem />
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

function WorkspaceSwitcherDropdown({
  projectSlug,
  projectId,
  currentWorkspaceId,
  currentWorkspaceLabel,
  currentWorkspaceName,
}: {
  projectSlug: string;
  projectId: string;
  currentWorkspaceId: string;
  currentWorkspaceLabel: string;
  currentWorkspaceName: string;
}) {
  const workspaceDropdownItemClassName =
    'h-auto items-start py-1.5 data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground [&>span:first-child]:hidden [&>span:last-child]:block [&>span:last-child]:w-full';
  const navigate = useNavigate();
  const { data: projectState } = trpc.workspace.getProjectSummaryState.useQuery(
    { projectId },
    {
      enabled: Boolean(projectId),
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnWindowFocus: false,
    }
  );

  const grouped = useMemo(
    () => groupWorkspaceSwitcherItems((projectState?.workspaces ?? []) as ServerWorkspace[]),
    [projectState?.workspaces]
  );

  const handleValueChange = (workspaceId: string) => {
    if (!workspaceId || workspaceId === currentWorkspaceId) {
      return;
    }
    void navigate(`/projects/${projectSlug}/workspaces/${workspaceId}`);
  };

  return (
    <Select value={currentWorkspaceId} onValueChange={handleValueChange}>
      <SelectTrigger
        id="workspace-detail-workspace-select"
        aria-label="Open workspace menu"
        className="h-7 w-auto max-w-[10rem] border-0 bg-transparent px-0.5 text-[11px] font-normal text-muted-foreground shadow-none focus:ring-0 hover:[&>span]:underline focus-visible:[&>span]:underline md:max-w-[18rem] md:px-1 md:text-sm lg:max-w-none [&>svg:last-of-type]:hidden"
      >
        <span className="flex-1 min-w-0 truncate text-foreground font-semibold md:overflow-visible md:text-clip">
          {currentWorkspaceLabel}
        </span>
        <span className="ml-0.5 inline-flex shrink-0 items-center text-current md:ml-2" aria-hidden>
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-70 md:h-3.5 md:w-3.5" />
        </span>
      </SelectTrigger>
      <SelectContent className="w-[min(95vw,34rem)]">
        <SelectItem value={currentWorkspaceId} className="hidden" aria-hidden>
          {currentWorkspaceName}
        </SelectItem>
        <SelectGroup>
          <SelectLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Waiting · {grouped.waiting.length}
          </SelectLabel>
          {grouped.waiting.map((workspace) => (
            <SelectItem
              key={`waiting-${workspace.id}`}
              value={workspace.id}
              className={workspaceDropdownItemClassName}
            >
              <WorkspaceItemContent
                workspace={workspace}
                onOpenPr={() => {
                  const prUrl = workspace.prUrl;
                  if (!prUrl) {
                    return;
                  }
                  window.open(prUrl, '_blank', 'noopener,noreferrer');
                }}
                onOpenIssue={() => {
                  const issueUrl = workspace.githubIssueUrl ?? workspace.linearIssueUrl;
                  if (!issueUrl) {
                    return;
                  }
                  window.open(issueUrl, '_blank', 'noopener,noreferrer');
                }}
              />
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Working · {grouped.working.length}
          </SelectLabel>
          {grouped.working.map((workspace) => (
            <SelectItem
              key={`working-${workspace.id}`}
              value={workspace.id}
              className={workspaceDropdownItemClassName}
            >
              <WorkspaceItemContent
                workspace={workspace}
                onOpenPr={() => {
                  const prUrl = workspace.prUrl;
                  if (!prUrl) {
                    return;
                  }
                  window.open(prUrl, '_blank', 'noopener,noreferrer');
                }}
                onOpenIssue={() => {
                  const issueUrl = workspace.githubIssueUrl ?? workspace.linearIssueUrl;
                  if (!issueUrl) {
                    return;
                  }
                  window.open(issueUrl, '_blank', 'noopener,noreferrer');
                }}
              />
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Todo · {grouped.todo.length}
          </SelectLabel>
          {grouped.todo.map((workspace) => (
            <SelectItem
              key={`todo-${workspace.id}`}
              value={workspace.id}
              className={workspaceDropdownItemClassName}
            >
              <WorkspaceItemContent
                workspace={workspace}
                onOpenPr={() => {
                  const prUrl = workspace.prUrl;
                  if (!prUrl) {
                    return;
                  }
                  window.open(prUrl, '_blank', 'noopener,noreferrer');
                }}
                onOpenIssue={() => {
                  const issueUrl = workspace.githubIssueUrl ?? workspace.linearIssueUrl;
                  if (!issueUrl) {
                    return;
                  }
                  window.open(issueUrl, '_blank', 'noopener,noreferrer');
                }}
              />
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Done · {grouped.done.length}
          </SelectLabel>
          {grouped.done.map((workspace) => (
            <SelectItem
              key={`done-${workspace.id}`}
              value={workspace.id}
              className={workspaceDropdownItemClassName}
            >
              <WorkspaceItemContent
                workspace={workspace}
                onOpenPr={() => {
                  const prUrl = workspace.prUrl;
                  if (!prUrl) {
                    return;
                  }
                  window.open(prUrl, '_blank', 'noopener,noreferrer');
                }}
                onOpenIssue={() => {
                  const issueUrl = workspace.githubIssueUrl ?? workspace.linearIssueUrl;
                  if (!issueUrl) {
                    return;
                  }
                  window.open(issueUrl, '_blank', 'noopener,noreferrer');
                }}
              />
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
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
  const { slug, projects, handleProjectChange, handleCurrentProjectSelect } =
    useWorkspaceProjectNavigation();
  useAppHeader({ title: '' });

  return (
    <>
      <HeaderLeftStartSlot>
        <div className="flex min-w-0 items-center gap-0.5">
          <ProjectSelectorDropdown
            selectedProjectSlug={slug}
            onProjectChange={handleProjectChange}
            onCurrentProjectSelect={handleCurrentProjectSelect}
            projects={projects}
            showLeadingSlash
            showTrailingSlash
            trailingSeparatorType="chevron"
            triggerId="workspace-detail-project-select"
          />
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
        </div>
      </HeaderLeftStartSlot>
      <HeaderLeftExtraSlot>
        <div className="hidden md:flex items-center gap-2 min-w-0">
          <WorkspacePrAction
            workspace={workspace}
            hasChanges={hasChanges}
            running={running}
            isCreatingSession={isCreatingSession}
            handleQuickAction={handleQuickAction}
          />
          <WorkspaceIssueLink workspace={workspace} />
          <WorkspaceCiStatus workspace={workspace} />
          <RunScriptPortBadge workspaceId={workspaceId} />
        </div>
      </HeaderLeftExtraSlot>
      <HeaderRightSlot>
        <div className={cn('flex items-center gap-0.5 shrink-0', !isMobile && 'flex-wrap gap-0.5')}>
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
              />
            </>
          ) : (
            <>
              <WorkspaceProviderSettings workspace={workspace} workspaceId={workspaceId} />
              <RatchetingToggle workspace={workspace} workspaceId={workspaceId} />
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
              <ToggleRightPanelButton />
            </>
          )}
        </div>
      </HeaderRightSlot>
    </>
  );
}
