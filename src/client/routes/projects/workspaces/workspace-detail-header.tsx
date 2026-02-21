import {
  AppWindow,
  Archive,
  CheckCircle2,
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
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
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
  SelectItem,
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
  WorkspacesBackLink,
} from '@/components/workspace';
import {
  HeaderLeftExtraSlot,
  HeaderLeftStartSlot,
  HeaderRightSlot,
  useAppHeader,
} from '@/frontend/components/app-header-context';
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
import { NewWorkspaceButton } from './components/new-workspace-button';
import { encodeGitHubTreeRef } from './github-branch-url';
import type { useSessionManagement, useWorkspaceData } from './use-workspace-detail';

type WorkspaceHeaderWorkspace = NonNullable<ReturnType<typeof useWorkspaceData>['workspace']>;

function hasVisiblePullRequest(workspace: WorkspaceHeaderWorkspace): boolean {
  return Boolean(
    workspace.prUrl &&
      workspace.prNumber &&
      workspace.prState !== 'NONE' &&
      workspace.prState !== 'CLOSED'
  );
}

function WorkspacePrChip({
  workspace,
  className,
}: {
  workspace: WorkspaceHeaderWorkspace;
  className?: string;
}) {
  if (!hasVisiblePullRequest(workspace)) {
    return null;
  }
  const prUrl = workspace.prUrl;
  const prNumber = workspace.prNumber;
  if (!(prUrl && prNumber)) {
    return null;
  }

  return (
    <a
      href={prUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'flex items-center gap-1 text-xs hover:opacity-80 transition-opacity',
        workspace.prState === 'MERGED'
          ? 'text-green-500'
          : 'text-muted-foreground hover:text-foreground',
        className
      )}
    >
      <GitPullRequest className="h-3 w-3" />#{prNumber}
      {workspace.prState === 'MERGED' && <CheckCircle2 className="h-3 w-3 text-green-500" />}
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
          className="h-9 w-9 md:h-8 md:w-8"
        >
          <PanelRight className={cn('h-4 w-4', rightPanelVisible && 'text-primary')} />
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
    return <WorkspacePrChip workspace={workspace} />;
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
              <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="More actions">
                <MoreHorizontal className="h-4 w-4" />
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
  onCreateWorkspace: () => void;
  isCreatingWorkspace: boolean;
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
  onCreateWorkspace,
  isCreatingWorkspace,
}: WorkspaceHeaderProps) {
  const isMobile = useIsMobile();
  const { slug = '' } = useParams<{ slug: string }>();

  const title =
    isMobile && hasVisiblePullRequest(workspace) ? (
      <WorkspacePrChip workspace={workspace} className="inline-flex max-w-full align-middle" />
    ) : (
      workspace.branchName || workspace.name
    );
  useAppHeader({ title });

  return (
    <>
      <HeaderLeftStartSlot>
        <WorkspacesBackLink projectSlug={slug} />
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
        <div
          className={cn(
            'flex items-center gap-1 shrink-0',
            !isMobile && 'flex-wrap gap-0.5 md:gap-1'
          )}
        >
          <NewWorkspaceButton onClick={onCreateWorkspace} isCreating={isCreatingWorkspace} />
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
