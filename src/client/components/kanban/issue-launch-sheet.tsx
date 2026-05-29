import { ExternalLink, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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
import { RatchetToggleButton } from '@/components/workspace';

interface IssueLaunchSheetProps {
  issue: NormalizedIssue;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted?: () => void;
}

type LaunchMode = 'non_interactive' | 'plan';
type AgentProvider = 'CLAUDE' | 'CODEX';

function getIssueProviderLabel(issue: NormalizedIssue) {
  return issue.provider === 'linear' ? 'Linear' : 'GitHub';
}

function buildPromptPreview(issue: NormalizedIssue) {
  const providerLabel = issue.provider === 'linear' ? 'Linear Issue' : 'GitHub Issue';
  const body = issue.body?.trim() || '(No description provided)';

  return `# ${providerLabel} ${issue.displayId}: ${issue.title}

${body}

Issue URL: ${issue.url}

Start with planning, then implement, test, review, and open a pull request.`;
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
  const [ratchetEnabled, setRatchetEnabled] = useState(false);
  const [startupModePreset, setStartupModePreset] = useState<LaunchMode>('non_interactive');
  const [provider, setProvider] = useState<AgentProvider>('CLAUDE');
  const ratchetPreferenceKey = `kanban:issue-ratchet:${projectId}:${issue.id}`;
  const promptPreview = useMemo(() => buildPromptPreview(issue), [issue]);
  const issueProviderLabel = getIssueProviderLabel(issue);

  useEffect(() => {
    if (!userSettings) {
      return;
    }

    setProvider(userSettings.defaultSessionProvider ?? 'CLAUDE');

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
    if (issue.provider === 'linear' && issue.linearIssueId && issue.linearIssueIdentifier) {
      createWorkspaceMutation.mutate({
        type: 'LINEAR_ISSUE',
        projectId,
        issueId: issue.linearIssueId,
        issueIdentifier: issue.linearIssueIdentifier,
        issueUrl: issue.url,
        name: issue.title,
        ratchetEnabled,
        startupModePreset,
        provider,
      });
    } else if (issue.githubIssueNumber) {
      createWorkspaceMutation.mutate({
        type: 'GITHUB_ISSUE',
        projectId,
        issueNumber: issue.githubIssueNumber,
        issueUrl: issue.url,
        name: issue.title,
        ratchetEnabled,
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
              <Label className="text-xs">Prompt Preview</Label>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" asChild>
                <a href={issue.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-3.5 w-3.5" />
                  {issueProviderLabel}
                </a>
              </Button>
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
              {promptPreview}
            </pre>
          </div>
        </div>

        <SheetFooter className="pt-2">
          <Button
            onClick={handleStart}
            disabled={createWorkspaceMutation.isPending || isLoadingSettings}
            className="w-full sm:w-auto"
          >
            <Play className="h-4 w-4 mr-2" />
            {createWorkspaceMutation.isPending ? 'Starting...' : 'Start'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
