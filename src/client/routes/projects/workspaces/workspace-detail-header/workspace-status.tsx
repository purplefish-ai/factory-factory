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
  const catalog = trpc.session.listQuickActions.useQuery(undefined, { staleTime: Infinity });
  const action = catalog.data?.find(
    (entry) => entry.id === CREATE_PULL_REQUEST_QUICK_ACTION_ID && entry.content
  );
  const hasOpenBranchPr = workspace.prs.some(
    (pr) =>
      pr.state !== 'MERGED' &&
      pr.state !== 'CLOSED' &&
      (!pr.headRefName || pr.headRefName === workspace.branchName)
  );
  if (!hasChanges || running || hasOpenBranchPr) {
    return null;
  }
  const loading = catalog.isPending || catalog.isLoading;
  // Chat creation is one mutation shared by every new-chat control, so this
  // shows the spinner whenever a chat is being created.
  const disabled = isCreatingSession || loading || !(action?.content || catalog.isError);
  const label = loading ? 'Loading PR action…' : catalog.isError ? 'Retry PR action' : 'Create PR';
  const description = catalog.isError
    ? "Couldn't load the PR action. Retry loading it."
    : !(loading || action?.content)
      ? 'The Create PR quick action is unavailable.'
      : 'Start a new chat that opens a pull request for this branch';
  const createPr = () => {
    if (catalog.isError) {
      void catalog.refetch();
      return;
    }
    if (action?.content && !disabled) {
      handleQuickAction(action.name, action.content);
    }
  };
  if (renderAsMenuItem) {
    return (
      <DropdownMenuItem disabled={disabled} pending={isCreatingSession} onSelect={createPr}>
        <GitPullRequestIcon className="h-3 w-3" />
        {label}
      </DropdownMenuItem>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            variant="ghost"
            size="xs"
            disabled={disabled}
            pending={isCreatingSession}
            onClick={createPr}
            title={description}
          >
            <GitPullRequestIcon />
            {label}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
    </Tooltip>
  );
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
