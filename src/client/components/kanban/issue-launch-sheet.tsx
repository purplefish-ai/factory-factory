import { ArrowSquareOutIcon, PlayIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { NormalizedIssue } from '@/client/lib/issue-normalization';
import { trpc } from '@/client/lib/trpc';
import { createOptimisticWorkspaceCacheData } from '@/client/lib/workspace-cache-helpers';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { RatchetToggleButton } from '@/components/workspace';
import { buildIssueStartPrompt } from '@/shared/issue-start-prompt';

interface IssueLaunchSheetProps {
  issue: NormalizedIssue;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted?: () => void;
}

type LaunchMode = 'non_interactive' | 'plan';
type AgentProvider = 'CLAUDE' | 'CODEX';
type PromptProject = {
  githubOwner?: string | null;
  githubRepo?: string | null;
};

function getIssueProviderLabel(issue: NormalizedIssue) {
  return issue.provider === 'linear' ? 'Linear' : 'GitHub';
}

function buildProjectRawScreenshotBaseUrl(project: PromptProject | null | undefined) {
  if (project?.githubOwner && project.githubRepo) {
    return `https://raw.githubusercontent.com/${project.githubOwner}/${project.githubRepo}/`;
  }

  return '';
}

function buildPromptPreview(issue: NormalizedIssue, project: PromptProject | null | undefined) {
  const providerLabel = issue.provider === 'linear' ? 'Linear Issue' : 'GitHub Issue';
  const projectRawScreenshotBaseUrl = buildProjectRawScreenshotBaseUrl(project);
  return buildIssueStartPrompt({
    providerLabel,
    issueReference: issue.displayId,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    commitReference: issue.displayId,
    closeReference: issue.displayId,
    rawScreenshotBaseUrl:
      projectRawScreenshotBaseUrl ||
      (issue.provider === 'github' ? deriveGitHubRawScreenshotBaseUrl(issue.url) : ''),
  });
}

function deriveGitHubRawScreenshotBaseUrl(issueUrl: string) {
  try {
    const url = new URL(issueUrl);
    const [owner, repo] = url.pathname.split('/').filter(Boolean);
    if (url.hostname === 'github.com' && owner && repo) {
      return `https://raw.githubusercontent.com/${owner}/${repo}/`;
    }
  } catch {
    // Fall through to an empty base URL for malformed issue links.
  }

  return '';
}

export function IssueLaunchSheet({
  issue,
  projectId,
  open,
  onOpenChange,
  onStarted,
}: IssueLaunchSheetProps) {
  const utils = trpc.useUtils();
  const { data: userSettings, isLoading: isLoadingSettings } = trpc.userSettings.get.useQuery();
  const { data: project, isLoading: isLoadingProject } = trpc.project.getById.useQuery({
    id: projectId,
  });
  const promptPreview = useMemo(() => buildPromptPreview(issue, project), [issue, project]);
  const [ratchetEnabled, setRatchetEnabled] = useState(false);
  const [startupModePreset, setStartupModePreset] = useState<LaunchMode>('non_interactive');
  const [provider, setProvider] = useState<AgentProvider>('CLAUDE');
  const [promptText, setPromptText] = useState(promptPreview);
  const initializedProviderForOpenRef = useRef(false);
  const initializedPromptIssueKeyRef = useRef<string | null>(null);
  const lastPromptPreviewRef = useRef(promptPreview);
  const ratchetPreferenceKey = `kanban:issue-ratchet:${projectId}:${issue.id}`;
  const issueProviderLabel = getIssueProviderLabel(issue);
  const issueKey = `${issue.provider}:${issue.id}`;
  const isPromptPreviewSyncPending =
    open &&
    initializedPromptIssueKeyRef.current === issueKey &&
    lastPromptPreviewRef.current !== promptPreview &&
    promptText === lastPromptPreviewRef.current;

  useEffect(() => {
    if (!open) {
      initializedProviderForOpenRef.current = false;
      initializedPromptIssueKeyRef.current = null;
      lastPromptPreviewRef.current = promptPreview;
      return;
    }

    const previousPromptPreview = lastPromptPreviewRef.current;
    if (initializedPromptIssueKeyRef.current !== issueKey) {
      setPromptText(promptPreview);
      initializedPromptIssueKeyRef.current = issueKey;
    } else if (previousPromptPreview !== promptPreview) {
      setPromptText((currentPromptText) =>
        currentPromptText === previousPromptPreview ? promptPreview : currentPromptText
      );
    }
    lastPromptPreviewRef.current = promptPreview;

    if (!userSettings || initializedProviderForOpenRef.current) {
      return;
    }

    setProvider(userSettings.defaultSessionProvider ?? 'CLAUDE');
    initializedProviderForOpenRef.current = true;
  }, [open, promptPreview, userSettings, issueKey]);

  useEffect(() => {
    if (!userSettings) {
      return;
    }

    try {
      const savedPreference = window.localStorage.getItem(ratchetPreferenceKey);
      if (savedPreference === 'true' || savedPreference === 'false') {
        setRatchetEnabled(savedPreference === 'true');
        return;
      }
    } catch {
      // Ignore localStorage failures and fall back to admin default.
    }
    setRatchetEnabled(userSettings.ratchetEnabled);
  }, [ratchetPreferenceKey, userSettings]);

  const createWorkspaceMutation = trpc.workspace.create.useMutation({
    onSuccess: (workspace) => {
      utils.workspace.get.setData({ id: workspace.id }, (old) => {
        if (old) {
          return old;
        }

        return createOptimisticWorkspaceCacheData(workspace);
      });

      utils.workspace.listWithKanbanState.invalidate({ projectId });
      utils.workspace.getProjectSummaryState.invalidate({ projectId });
      onOpenChange(false);
      onStarted?.();
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to start workspace');
    },
  });

  const handleRatchetToggle = (enabled: boolean) => {
    setRatchetEnabled(enabled);
    try {
      window.localStorage.setItem(ratchetPreferenceKey, String(enabled));
    } catch {
      // Ignore localStorage failures without interrupting the toggle.
    }
  };

  const handleStart = () => {
    const currentPromptText = isPromptPreviewSyncPending ? promptPreview : promptText;
    const trimmedPrompt = currentPromptText.trim();
    if (issue.provider === 'linear' && issue.linearIssueId && issue.linearIssueIdentifier) {
      createWorkspaceMutation.mutate({
        type: 'LINEAR_ISSUE',
        projectId,
        issueId: issue.linearIssueId,
        issueIdentifier: issue.linearIssueIdentifier,
        issueUrl: issue.url,
        name: issue.title,
        ratchetEnabled,
        initialPrompt: trimmedPrompt,
        startupModePreset,
        provider,
      });
    } else if (issue.githubIssueNumber) {
      if (!trimmedPrompt) {
        toast.error('Prompt cannot be empty');
        return;
      }

      createWorkspaceMutation.mutate({
        type: 'GITHUB_ISSUE',
        projectId,
        issueNumber: issue.githubIssueNumber,
        issueUrl: issue.url,
        name: issue.title,
        ratchetEnabled,
        initialPrompt: trimmedPrompt,
        startupModePreset,
        provider,
      });
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col">
        <SheetHeader>
          <SheetTitle className="pr-6">Start Issue</SheetTitle>
          <SheetDescription className="line-clamp-2">
            {issue.displayId} · {issue.title}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={`issue-mode-${issue.id}`} className="text-xs">
                Mode
              </Label>
              <Select
                value={startupModePreset}
                onValueChange={(value) => setStartupModePreset(value as LaunchMode)}
                disabled={createWorkspaceMutation.isPending || isLoadingSettings}
              >
                <SelectTrigger id={`issue-mode-${issue.id}`} className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="non_interactive">Autonomous</SelectItem>
                  <SelectItem value="plan">Planning</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`issue-provider-${issue.id}`} className="text-xs">
                Provider
              </Label>
              <Select
                value={provider}
                onValueChange={(value) => setProvider(value as AgentProvider)}
                disabled={createWorkspaceMutation.isPending || isLoadingSettings}
              >
                <SelectTrigger id={`issue-provider-${issue.id}`} className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CLAUDE">Claude</SelectItem>
                  <SelectItem value="CODEX">Codex</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <div>
              <div className="text-sm font-medium">Ratchet</div>
              <div className="text-xs text-muted-foreground">{ratchetEnabled ? 'On' : 'Off'}</div>
            </div>
            <RatchetToggleButton
              enabled={ratchetEnabled}
              state="IDLE"
              className="h-6 w-6"
              stopPropagation={false}
              disabled={isLoadingSettings || createWorkspaceMutation.isPending}
              onToggle={handleRatchetToggle}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={`issue-prompt-${issue.id}`} className="text-xs">
                Prompt
              </Label>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" asChild>
                <a href={issue.url} target="_blank" rel="noreferrer">
                  <ArrowSquareOutIcon className="h-3.5 w-3.5" />
                  {issueProviderLabel}
                </a>
              </Button>
            </div>
            <Textarea
              id={`issue-prompt-${issue.id}`}
              value={promptText}
              onChange={(event) => setPromptText(event.target.value)}
              disabled={createWorkspaceMutation.isPending || isLoadingSettings || isLoadingProject}
              className="min-h-64 resize-y whitespace-pre-wrap bg-muted/20 font-mono text-xs leading-relaxed text-muted-foreground"
            />
          </div>
        </div>

        <SheetFooter className="pt-2">
          <Button
            onClick={handleStart}
            disabled={
              createWorkspaceMutation.isPending ||
              isLoadingSettings ||
              isLoadingProject ||
              isPromptPreviewSyncPending ||
              (issue.provider === 'github' && !promptText.trim())
            }
            className="w-full sm:w-auto"
          >
            <PlayIcon className="h-4 w-4 mr-2" />
            {createWorkspaceMutation.isPending ? 'Starting...' : 'Start'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
