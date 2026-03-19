import { CheckCircle2, CircleDot, GitPullRequest } from 'lucide-react';
import { CiStatusChip } from '@/components/shared/ci-status-chip';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { WorkspaceHeaderWorkspace, WorkspacePrChipProps } from './types';
import { hasVisiblePullRequest, isWorkspaceMerged } from './utils';

type WorkspacePrActionProps = {
  workspace: WorkspaceHeaderWorkspace;
  hasChanges?: boolean;
  running: boolean;
  isCreatingSession: boolean;
  handleQuickAction: (title: string, prompt: string) => void;
};

export function WorkspacePrChip({ prUrl, prNumber, isMerged, className }: WorkspacePrChipProps) {
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

export function WorkspacePrAction({
  workspace,
  hasChanges,
  running,
  isCreatingSession,
  handleQuickAction,
}: WorkspacePrActionProps) {
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

export function WorkspaceIssueLink({ workspace }: { workspace: WorkspaceHeaderWorkspace }) {
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

export function WorkspaceCiStatus({ workspace }: { workspace: WorkspaceHeaderWorkspace }) {
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
