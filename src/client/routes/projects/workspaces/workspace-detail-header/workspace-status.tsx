import { DotOutlineIcon } from '@phosphor-icons/react/dist/csr/DotOutline';
import { GitPullRequestIcon } from '@phosphor-icons/react/dist/csr/GitPullRequest';
import { CiStatusChip } from '@/client/components/ci-status-chip';
import { PrStateBadge } from '@/client/components/pr-state-badge';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { WorkspaceHeaderWorkspace } from './types';

type WorkspacePrActionProps = {
  workspace: WorkspaceHeaderWorkspace;
  hasChanges?: boolean;
  running: boolean;
  isCreatingSession: boolean;
  handleQuickAction: (title: string, prompt: string) => void;
  renderAsMenuItem?: boolean;
};

export function WorkspacePrAction({
  workspace,
  hasChanges,
  running,
  isCreatingSession,
  handleQuickAction,
  renderAsMenuItem = false,
}: WorkspacePrActionProps) {
  if (
    hasChanges &&
    !running &&
    !workspace.prs.some(
      (pr) =>
        pr.state !== 'MERGED' &&
        pr.state !== 'CLOSED' &&
        (!pr.headRefName || pr.headRefName === workspace.branchName)
    )
  ) {
    const createPr = () =>
      handleQuickAction(
        'Create Pull Request',
        'Create a pull request for the current branch using the GitHub CLI (gh). Include a clear title and description summarizing the changes.'
      );
    if (renderAsMenuItem) {
      return (
        <DropdownMenuItem disabled={isCreatingSession} onSelect={createPr}>
          <GitPullRequestIcon className="h-3 w-3" />
          Create PR
        </DropdownMenuItem>
      );
    }
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 text-xs px-2"
            disabled={isCreatingSession}
            onClick={createPr}
          >
            <GitPullRequestIcon className="h-3 w-3" />
            Create PR
          </Button>
        </TooltipTrigger>
        <TooltipContent>Create a pull request for this branch</TooltipContent>
      </Tooltip>
    );
  }

  return null;
}

export function WorkspaceIssueLink({
  workspace,
  renderAsMenuItem = false,
}: {
  workspace: WorkspaceHeaderWorkspace;
  renderAsMenuItem?: boolean;
}) {
  const hasLinearIssue = Boolean(workspace.linearIssueIdentifier && workspace.linearIssueUrl);
  const url = hasLinearIssue ? workspace.linearIssueUrl : workspace.githubIssueUrl;
  const label = hasLinearIssue
    ? workspace.linearIssueIdentifier
    : workspace.githubIssueNumber
      ? `#${workspace.githubIssueNumber}`
      : null;
  if (renderAsMenuItem) {
    return url && label ? (
      <DropdownMenuItem asChild>
        <a href={url} target="_blank" rel="noopener noreferrer">
          <DotOutlineIcon className="h-3 w-3" />
          {label}
        </a>
      </DropdownMenuItem>
    ) : null;
  }
  if (workspace.linearIssueIdentifier && workspace.linearIssueUrl) {
    return (
      <a
        href={workspace.linearIssueUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-opacity hover:opacity-80"
      >
        <DotOutlineIcon className="h-3 w-3 text-violet-500" />
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
        <DotOutlineIcon className="h-3 w-3 text-green-500" />#{workspace.githubIssueNumber}
      </a>
    );
  }

  return null;
}

export function WorkspaceCiStatus({ workspace }: { workspace: WorkspaceHeaderWorkspace }) {
  if (!workspace.prSummary.totalCount) {
    return null;
  }

  if (!workspace.sidebarStatus) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      <CiStatusChip
        ciState={workspace.sidebarStatus.ciState}
        prState={workspace.prState}
        size="md"
      />
      <PrStateBadge prState={workspace.prState} size="md" />
    </div>
  );
}
