import {
  AppWindow,
  Archive,
  CheckCircle2,
  GitBranch,
  GitPullRequest,
  Loader2,
  PanelRight,
  Settings2,
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
import { trpc } from '@/frontend/lib/trpc';
import { cn } from '@/lib/utils';

import type {
  NewSessionProviderSelection,
  useSessionManagement,
  useWorkspaceData,
} from './use-workspace-detail';

type SessionProviderValue = 'CLAUDE' | 'CODEX';

const EXPLICIT_PROVIDER_OPTIONS = [
  { value: 'CLAUDE', label: 'Claude' },
  { value: 'CODEX', label: 'Codex' },
] as const;

function resolveProviderSelection(value: unknown): NewSessionProviderSelection {
  if (value === 'CLAUDE' || value === 'CODEX' || value === 'WORKSPACE_DEFAULT') {
    return value;
  }
  return 'WORKSPACE_DEFAULT';
}

function resolveEffectiveSessionProvider(
  workspaceDefaultProvider: unknown,
  userDefaultProvider: unknown
): SessionProviderValue {
  if (workspaceDefaultProvider === 'CLAUDE' || workspaceDefaultProvider === 'CODEX') {
    return workspaceDefaultProvider;
  }
  return userDefaultProvider === 'CODEX' ? 'CODEX' : 'CLAUDE';
}

function getProviderLabel(provider: SessionProviderValue): string {
  return provider === 'CODEX' ? 'Codex' : 'Claude';
}

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
      <div className="flex items-center gap-1.5 min-w-0">
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

function NewSessionProviderSelect({
  selectedProvider,
  setSelectedProvider,
  disabled,
  effectiveDefaultProvider,
}: {
  selectedProvider: NewSessionProviderSelection;
  setSelectedProvider: React.Dispatch<React.SetStateAction<NewSessionProviderSelection>>;
  disabled: boolean;
  effectiveDefaultProvider: SessionProviderValue;
}) {
  const triggerLabel = getProviderLabel(
    selectedProvider === 'WORKSPACE_DEFAULT' ? effectiveDefaultProvider : selectedProvider
  );

  return (
    <Select
      value={selectedProvider}
      onValueChange={(value) => {
        setSelectedProvider(resolveProviderSelection(value));
      }}
      disabled={disabled}
    >
      <SelectTrigger className="h-8 w-[148px] text-xs">
        <span className="truncate">{triggerLabel}</span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem key="workspace-default-provider" value="WORKSPACE_DEFAULT">
          Use default ({getProviderLabel(effectiveDefaultProvider)})
        </SelectItem>
        {EXPLICIT_PROVIDER_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function WorkspaceProviderSettings({
  workspace,
  workspaceId,
}: {
  workspace: NonNullable<ReturnType<typeof useWorkspaceData>['workspace']>;
  workspaceId: string;
}) {
  const [open, setOpen] = useState(false);
  const [defaultProvider, setDefaultProvider] = useState<NewSessionProviderSelection>(
    resolveProviderSelection(workspace.defaultSessionProvider)
  );
  const [ratchetProvider, setRatchetProvider] = useState<NewSessionProviderSelection>(
    resolveProviderSelection(workspace.ratchetSessionProvider)
  );
  const utils = trpc.useUtils();

  const updateProviderDefaults = trpc.workspace.updateProviderDefaults.useMutation({
    onSuccess: () => {
      utils.workspace.get.invalidate({ id: workspaceId });
      utils.workspace.listWithKanbanState.invalidate({ projectId: workspace.projectId });
      utils.workspace.getProjectSummaryState.invalidate({ projectId: workspace.projectId });
      setOpen(false);
    },
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    setDefaultProvider(resolveProviderSelection(workspace.defaultSessionProvider));
    setRatchetProvider(resolveProviderSelection(workspace.ratchetSessionProvider));
  }, [open, workspace.defaultSessionProvider, workspace.ratchetSessionProvider]);

  const currentDefaultProvider = resolveProviderSelection(workspace.defaultSessionProvider);
  const currentRatchetProvider = resolveProviderSelection(workspace.ratchetSessionProvider);
  const isDirty =
    defaultProvider !== currentDefaultProvider || ratchetProvider !== currentRatchetProvider;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Provider settings">
              <Settings2 className="h-4 w-4" />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>Provider settings</TooltipContent>
      </Tooltip>
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
                <SelectItem value="WORKSPACE_DEFAULT">Workspace Default</SelectItem>
                {EXPLICIT_PROVIDER_OPTIONS.map((option) => (
                  <SelectItem key={`default-${option.value}`} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
                <SelectItem value="WORKSPACE_DEFAULT">Workspace Default</SelectItem>
                {EXPLICIT_PROVIDER_OPTIONS.map((option) => (
                  <SelectItem key={`ratchet-${option.value}`} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
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

interface WorkspaceHeaderProps {
  workspace: NonNullable<ReturnType<typeof useWorkspaceData>['workspace']>;
  workspaceId: string;
  availableIdes: ReturnType<typeof useSessionManagement>['availableIdes'];
  preferredIde: ReturnType<typeof useSessionManagement>['preferredIde'];
  openInIde: ReturnType<typeof useSessionManagement>['openInIde'];
  archivePending: boolean;
  onArchiveRequest: () => void;
  handleQuickAction: ReturnType<typeof useSessionManagement>['handleQuickAction'];
  selectedProvider: NewSessionProviderSelection;
  setSelectedProvider: React.Dispatch<React.SetStateAction<NewSessionProviderSelection>>;
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
  selectedProvider,
  setSelectedProvider,
  running,
  isCreatingSession,
  hasChanges,
}: WorkspaceHeaderProps) {
  const { data: userSettings } = trpc.userSettings.get.useQuery();
  const effectiveDefaultProvider = resolveEffectiveSessionProvider(
    workspace.defaultSessionProvider,
    userSettings?.defaultSessionProvider
  );

  return (
    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-1 md:gap-2 px-2 py-1.5 md:px-4 md:py-2 border-b">
      <div className="flex items-center gap-2 md:gap-3 min-w-0">
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
      <div className="flex items-center justify-end gap-0.5 md:gap-1 shrink-0">
        <NewSessionProviderSelect
          selectedProvider={selectedProvider}
          setSelectedProvider={setSelectedProvider}
          disabled={isCreatingSession}
          effectiveDefaultProvider={effectiveDefaultProvider}
        />
        <WorkspaceProviderSettings workspace={workspace} workspaceId={workspaceId} />
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
