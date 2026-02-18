import { CircleDot, ExternalLink, Play, User } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/ui/markdown';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { RatchetToggleButton } from '@/components/workspace';
import { trpc } from '@/frontend/lib/trpc';
import type { KanbanIssue } from './kanban-context';

interface IssueDetailsSheetProps {
  issue: KanbanIssue | null;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function IssueDetailsSheet({
  issue,
  projectId,
  open,
  onOpenChange,
}: IssueDetailsSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col p-0">
        {issue ? (
          <IssueDetailsContent
            issue={issue}
            projectId={projectId}
            open={open}
            onOpenChange={onOpenChange}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted-foreground">No issue selected</p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function IssueDetailsContent({
  issue,
  projectId,
  open,
  onOpenChange,
}: {
  issue: KanbanIssue;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const { data: userSettings, isLoading: isLoadingSettings } = trpc.userSettings.get.useQuery();
  const [ratchetEnabled, setRatchetEnabled] = useState(false);

  const isGitHub = issue.provider === 'github';
  const isLinear = issue.provider === 'linear';

  // Fetch full GitHub issue details when the sheet opens
  const { data: githubDetailsData, isLoading: isLoadingGithubDetails } =
    trpc.github.getIssue.useQuery(
      { projectId, issueNumber: issue.githubIssueNumber ?? 0 },
      { enabled: open && isGitHub }
    );

  // Fetch full Linear issue details when the sheet opens
  const { data: linearDetailsData, isLoading: isLoadingLinearDetails } =
    trpc.linear.getIssue.useQuery(
      { projectId, issueId: issue.linearIssueId ?? '' },
      { enabled: open && isLinear }
    );

  const issueBody = isLinear
    ? linearDetailsData?.issue?.description
    : githubDetailsData?.issue?.body;
  const isLoadingDetails = isLinear ? isLoadingLinearDetails : isLoadingGithubDetails;

  const ratchetPreferenceKey = `kanban:issue-ratchet:${projectId}:${issue.id}`;

  useEffect(() => {
    if (userSettings?.ratchetEnabled === undefined) {
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
  }, [ratchetPreferenceKey, userSettings?.ratchetEnabled]);

  const createWorkspaceMutation = trpc.workspace.create.useMutation({
    onSuccess: () => {
      onOpenChange(false);
      utils.workspace.listWithKanbanState.invalidate({ projectId });
    },
  });

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
      });
    } else if (issue.githubIssueNumber) {
      createWorkspaceMutation.mutate({
        type: 'GITHUB_ISSUE',
        projectId,
        issueNumber: issue.githubIssueNumber,
        issueUrl: issue.url,
        name: issue.title,
        ratchetEnabled,
      });
    }
  };

  const externalLabel = isLinear ? 'Open in Linear' : 'Open in GitHub';

  return (
    <>
      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto p-4">
        <SheetHeader className="pb-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <SheetTitle className="text-xl leading-tight pr-8">{issue.title}</SheetTitle>
              <SheetDescription className="flex items-center gap-2 text-xs mt-2">
                <span className="inline-flex items-center gap-1">
                  <CircleDot className="h-3 w-3 text-green-500" />
                  <span>{issue.displayId}</span>
                </span>
                <span>•</span>
                <span className="inline-flex items-center gap-1">
                  <User className="h-3 w-3" />
                  {issue.author}
                </span>
                <span>•</span>
                <span>{new Date(issue.createdAt).toLocaleDateString()}</span>
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        {/* Issue Body */}
        <div>
          <h3 className="text-sm font-semibold mb-2">Description</h3>
          {isLoadingDetails ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          ) : issueBody ? (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <MarkdownRenderer content={issueBody} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">No description provided.</p>
          )}
        </div>
      </div>

      {/* Fixed footer with action buttons */}
      <div className="border-t p-4 space-y-3">
        <div className="flex items-center gap-2">
          <RatchetToggleButton
            enabled={ratchetEnabled}
            state="IDLE"
            className="h-6 w-6 shrink-0"
            stopPropagation={false}
            disabled={isLoadingSettings || createWorkspaceMutation.isPending}
            onToggle={(enabled) => {
              setRatchetEnabled(enabled);
              try {
                window.localStorage.setItem(ratchetPreferenceKey, String(enabled));
              } catch {
                // Ignore localStorage failures without interrupting the toggle.
              }
            }}
          />
          <span className="text-xs text-muted-foreground">
            {ratchetEnabled ? 'Ratcheting enabled' : 'Ratcheting disabled'}
          </span>
        </div>

        <div className="flex gap-2">
          <Button
            onClick={() => window.open(issue.url, '_blank', 'noopener,noreferrer')}
            variant="outline"
          >
            <ExternalLink className="h-4 w-4 mr-2" />
            {externalLabel}
          </Button>
          <Button
            onClick={handleStart}
            disabled={createWorkspaceMutation.isPending || isLoadingSettings}
            className="flex-1"
          >
            <Play className="h-4 w-4 mr-2" />
            {createWorkspaceMutation.isPending ? 'Starting...' : 'Start Issue'}
          </Button>
        </div>
      </div>
    </>
  );
}
