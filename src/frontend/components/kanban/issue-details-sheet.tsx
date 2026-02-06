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
import type { GitHubIssue } from './kanban-context';

interface IssueDetailsSheetProps {
  issue: GitHubIssue | null;
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
  const utils = trpc.useUtils();
  const { data: userSettings, isLoading: isLoadingSettings } = trpc.userSettings.get.useQuery();
  const [ratchetEnabled, setRatchetEnabled] = useState(false);

  // Fetch full issue details when the sheet opens
  const {
    data: issueDetailsData,
    isLoading: isLoadingDetails,
    refetch: refetchDetails,
  } = trpc.github.getIssue.useQuery(
    { projectId, issueNumber: issue?.number ?? 0 },
    { enabled: open && !!issue }
  );

  const issueDetails = issueDetailsData?.issue;
  const ratchetPreferenceKey = issue ? `kanban:issue-ratchet:${projectId}:${issue.number}` : '';

  useEffect(() => {
    if (!issue || userSettings?.ratchetEnabled === undefined) {
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
  }, [ratchetPreferenceKey, userSettings?.ratchetEnabled, issue]);

  const createWorkspaceMutation = trpc.workspace.create.useMutation({
    onSuccess: () => {
      // Close the sheet and invalidate workspace queries to refresh the board
      onOpenChange(false);
      utils.workspace.listWithKanbanState.invalidate({ projectId });
    },
  });

  const handleStart = () => {
    if (!issue) {
      return;
    }

    createWorkspaceMutation.mutate({
      type: 'GITHUB_ISSUE',
      projectId,
      issueNumber: issue.number,
      issueUrl: issue.url,
      issueLabels: issue.labels,
      name: issue.title,
      ratchetEnabled,
    });
  };

  const handleOpenInGitHub = () => {
    if (!issue) {
      return;
    }
    window.open(issue.url, '_blank', 'noopener,noreferrer');
  };

  // Refetch details when issue changes
  useEffect(() => {
    if (open && issue) {
      refetchDetails();
    }
  }, [issue, open, refetchDetails]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col p-0">
        {issue ? (
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
                        <span>#{issue.number}</span>
                      </span>
                      <span>•</span>
                      <span className="inline-flex items-center gap-1">
                        <User className="h-3 w-3" />
                        {issue.author.login}
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
                ) : issueDetails?.body ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <MarkdownRenderer content={issueDetails.body} />
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
                <Button onClick={handleOpenInGitHub} variant="outline">
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Open in GitHub
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
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted-foreground">No issue selected</p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
