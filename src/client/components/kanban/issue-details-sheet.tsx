import { ArrowSquareOutIcon, DotOutlineIcon, PlayIcon, UserIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import type { NormalizedIssue } from '@/client/lib/issue-normalization';
import { trpc } from '@/client/lib/trpc';
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
import { IssueLaunchSheet } from './issue-launch-sheet';

interface IssueDetailsSheetProps {
  issue: NormalizedIssue | null;
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
  issue: NormalizedIssue;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [launchSheetOpen, setLaunchSheetOpen] = useState(false);

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
                  <DotOutlineIcon className="h-3 w-3 text-green-500" />
                  <span>{issue.displayId}</span>
                </span>
                <span>•</span>
                <span className="inline-flex items-center gap-1">
                  <UserIcon className="h-3 w-3" />
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
      <div className="border-t p-4">
        <div className="flex gap-2">
          <Button
            onClick={() => window.open(issue.url, '_blank', 'noopener,noreferrer')}
            variant="outline"
          >
            <ArrowSquareOutIcon className="h-4 w-4 mr-2" />
            {externalLabel}
          </Button>
          <Button onClick={() => setLaunchSheetOpen(true)} className="flex-1">
            <PlayIcon className="h-4 w-4 mr-2" />
            Start Issue
          </Button>
        </div>
      </div>

      <IssueLaunchSheet
        issue={issue}
        projectId={projectId}
        open={launchSheetOpen}
        onOpenChange={setLaunchSheetOpen}
        onStarted={() => onOpenChange(false)}
      />
    </>
  );
}
