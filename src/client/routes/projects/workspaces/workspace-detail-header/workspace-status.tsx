import { DotOutlineIcon } from '@phosphor-icons/react/dist/csr/DotOutline';
import { GitPullRequestIcon } from '@phosphor-icons/react/dist/csr/GitPullRequest';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CREATE_PULL_REQUEST_QUICK_ACTION_ID } from '@/shared/quick-actions';
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
  // The same catalog entry as the quick actions menu's "Create Pull Request".
  const { data: quickActions } = trpc.session.listQuickActions.useQuery(undefined, {
    staleTime: Infinity,
  });
  const createPrAction = quickActions?.find(
    (action) => action.id === CREATE_PULL_REQUEST_QUICK_ACTION_ID && action.content
  );
  // Once the branch has an open PR, the PR chip next to this button shows it instead.
  if (
    createPrAction?.content &&
    hasChanges &&
    !running &&
    !workspace.prs.some(
      (pr) =>
        pr.state !== 'MERGED' &&
        pr.state !== 'CLOSED' &&
        (!pr.headRefName || pr.headRefName === workspace.branchName)
    )
  ) {
    const prompt = createPrAction.content;
    const createPr = () => handleQuickAction(createPrAction.name, prompt);
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
        <TooltipContent>Start a new chat that opens a pull request for this branch</TooltipContent>
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
        <DotOutlineIcon className="h-3 w-3" />
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
        <DotOutlineIcon className="h-3 w-3" />#{workspace.githubIssueNumber}
      </a>
    );
  }

  return null;
}
