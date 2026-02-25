import { CircleDot, GitBranch, GitPullRequest } from 'lucide-react';
import { PendingRequestBadge } from '@/client/components/pending-request-badge';
import type { ServerWorkspace } from '@/client/components/use-workspace-list-state';
import { WorkspaceStatusIcon } from '@/client/components/workspace-status-icon';

export function WorkspaceItemContent({
  workspace,
  onOpenPr,
  onOpenIssue,
}: {
  workspace: ServerWorkspace;
  onOpenPr?: () => void;
  onOpenIssue?: () => void;
}) {
  const showBranch = Boolean(workspace.branchName);
  const showPR =
    workspace.prState !== 'NONE' &&
    workspace.prState != null &&
    workspace.prNumber != null &&
    workspace.prUrl != null;
  const showStats =
    workspace.gitStats && (workspace.gitStats.additions > 0 || workspace.gitStats.deletions > 0);
  const hasMetaRow = showBranch || showPR || showStats;

  const issueLabel = workspace.linearIssueIdentifier
    ? workspace.linearIssueIdentifier
    : workspace.githubIssueNumber
      ? `#${workspace.githubIssueNumber}`
      : workspace.linearIssueId;
  const hasIssue = Boolean(issueLabel);

  return (
    <div className="flex flex-col gap-0.5 min-w-0 w-full">
      <div className="flex items-center gap-2 min-w-0">
        <WorkspaceStatusIcon
          pendingRequestType={workspace.pendingRequestType}
          isWorking={workspace.isWorking}
        />
        <span className="truncate text-sm">{workspace.name}</span>
      </div>
      {hasMetaRow && (
        <div className="grid grid-cols-[1fr_auto_3rem] items-center gap-x-2 pl-[calc(0.5rem+8px)] text-[11px] text-muted-foreground min-w-0">
          <span className="flex items-center gap-1 min-w-0 truncate">
            {showBranch && (
              <>
                <GitBranch className="h-2.5 w-2.5 shrink-0" />
                <span className="font-mono truncate">{workspace.branchName}</span>
              </>
            )}
          </span>
          <span className="flex items-center gap-1 shrink-0 justify-end">
            {showStats && workspace.gitStats && (
              <>
                <span className="text-green-600">+{workspace.gitStats.additions}</span>
                <span className="text-red-600">-{workspace.gitStats.deletions}</span>
              </>
            )}
          </span>
          <span className="shrink-0 justify-self-end">
            {showPR &&
              (onOpenPr ? (
                <button
                  type="button"
                  className="flex items-center gap-0.5 hover:text-foreground"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onOpenPr();
                  }}
                >
                  <GitPullRequest className="h-2.5 w-2.5" />
                  <span>#{workspace.prNumber}</span>
                </button>
              ) : (
                <span className="flex items-center gap-0.5">
                  <GitPullRequest className="h-2.5 w-2.5" />
                  <span>#{workspace.prNumber}</span>
                </span>
              ))}
          </span>
        </div>
      )}
      {workspace.pendingRequestType && (
        <div className="pl-[calc(0.5rem+8px)]">
          <PendingRequestBadge type={workspace.pendingRequestType} size="xs" />
        </div>
      )}
      {hasIssue && (
        <div className="pl-[calc(0.5rem+8px)]">
          {onOpenIssue ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenIssue();
              }}
            >
              <CircleDot className="h-2.5 w-2.5" />
              {issueLabel}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <CircleDot className="h-2.5 w-2.5" />
              {issueLabel}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
