import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { RatchetToggleButton } from '@/client/features/workspace';
import { usePersistedState } from '@/client/hooks/use-persisted-state';
import { runInBackground } from '@/client/lib/background-task';
import type { NormalizedIssue } from '@/client/lib/issue-normalization';
import { trpc } from '@/client/lib/trpc';
import { useUserSettings } from '@/client/lib/user-settings-queries';
import { seedCreatedWorkspaceDetail } from '@/client/lib/workspace-cache-helpers';
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
/** What the open sheet has adopted: its issue, prompt preview and default provider. */
interface OpeningSync {
  issueKey: string;
  promptPreview: string;
  providerDefaulted: boolean;
}

/**
 * The editable prompt and provider. Each opening and each issue starts from
 * the prompt preview, an untouched prompt follows preview changes, and the
 * provider takes the user's default once per opening. Adjusted during render
 * so no commit shows a stale prompt.
 */
function useIssueLaunchDraft({
  open,
  issueKey,
  promptPreview,
  defaultProvider,
}: {
  open: boolean;
  issueKey: string;
  promptPreview: string;
  /** Undefined until settings load. */
  defaultProvider: AgentProvider | undefined;
}) {
  const [provider, setProvider] = useState<AgentProvider>('CLAUDE');
  const [promptText, setPromptText] = useState(promptPreview);
  const [opening, setOpening] = useState<OpeningSync | null>(null);
  if (!open) {
    if (opening) {
      setOpening(null);
    }
    return { provider, setProvider, promptText, setPromptText };
  }
  let next: OpeningSync = opening ?? { issueKey: '', promptPreview: '', providerDefaulted: false };
  if (next.issueKey !== issueKey) {
    setPromptText(promptPreview);
    next = { ...next, issueKey, promptPreview };
  } else if (next.promptPreview !== promptPreview) {
    if (promptText === next.promptPreview) {
      setPromptText(promptPreview);
    }
    next = { ...next, promptPreview };
  }
  if (defaultProvider && !next.providerDefaulted) {
    setProvider(defaultProvider);
    next = { ...next, providerDefaulted: true };
  }
  if (next !== opening) {
    setOpening(next);
  }
  return { provider, setProvider, promptText, setPromptText };
}

function getIssueProviderLabel(issue: NormalizedIssue) {
  return issue.provider === 'linear' ? 'Linear' : 'GitHub';
}

export function IssueLaunchSheet({
  issue,
  projectId,
  open,
  onOpenChange,
  onStarted,
}: IssueLaunchSheetProps) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const { data: userSettings, isLoading: isLoadingSettings } = useUserSettings();
  const promptPreview = useMemo(
    () => buildIssueStartPrompt({ url: issue.url, prompt: userSettings?.ticketDispatchPrompt }),
    [issue.url, userSettings?.ticketDispatchPrompt]
  );
  const [startupModePreset, setStartupModePreset] = useState<LaunchMode>('non_interactive');
  // This issue's explicit choice, else the admin default once settings load.
  const [storedRatchetEnabled, setStoredRatchetEnabled] = usePersistedState(
    `kanban:issue-ratchet:${projectId}:${issue.id}`,
    z.boolean().nullable(),
    null
  );
  const ratchetEnabled = storedRatchetEnabled ?? userSettings?.ratchetEnabled ?? false;
  const issueProviderLabel = getIssueProviderLabel(issue);
  const { provider, setProvider, promptText, setPromptText } = useIssueLaunchDraft({
    open,
    issueKey: `${issue.provider}:${issue.id}`,
    promptPreview,
    defaultProvider: userSettings ? (userSettings.defaultSessionProvider ?? 'CLAUDE') : undefined,
  });

  const createWorkspaceMutation = trpc.workspace.create.useMutation({
    onSuccess: (workspace) => {
      seedCreatedWorkspaceDetail(queryClient, workspace);

      runInBackground(
        utils.workspace.listForProject.invalidate({ projectId }),
        "Couldn't refresh data."
      );
      onOpenChange(false);
      onStarted?.();
    },
    onError: (error) => {
      toast.error(error.message || "Couldn't start workspace.");
    },
  });

  const handleRatchetToggle = (enabled: boolean) => {
    setStoredRatchetEnabled(enabled);
  };

  const handleStart = () => {
    const trimmedPrompt = promptText.trim();
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
        toast.error("Couldn't start workspace. Enter a prompt.");
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
          <SheetTitle className="pr-6">Start issue</SheetTitle>
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
              size="icon-xs"
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
              <Button variant="ghost" size="compact" asChild>
                <a href={issue.url} target="_blank" rel="noreferrer">
                  <ArrowSquareOutIcon />
                  {issueProviderLabel}
                </a>
              </Button>
            </div>
            <Textarea
              id={`issue-prompt-${issue.id}`}
              value={promptText}
              onChange={(event) => setPromptText(event.target.value)}
              disabled={createWorkspaceMutation.isPending || isLoadingSettings}
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
              (issue.provider === 'github' && !promptText.trim())
            }
            className="w-full sm:w-auto"
          >
            <PlayIcon className="mr-2" />
            {createWorkspaceMutation.isPending ? 'Starting…' : 'Start'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
