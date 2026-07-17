import {
  ClockIcon,
  DotOutlineIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  TreeStructureIcon,
} from '@phosphor-icons/react';
import type { ServerWorkspace } from '@/client/components/use-workspace-list-state';
import { WorkspaceStatusIcon } from '@/client/components/workspace-status-icon';
import { getVisibleWorkspaceStatusReason } from '@/client/lib/workspace-status-reason-display';

function CreationSourceIcon({ creationSource }: { creationSource?: string | null }) {
  if (creationSource === 'PERIODIC_TASK') {
    return <ClockIcon className="h-3 w-3 shrink-0 text-muted-foreground" />;
  }
  if (creationSource === 'CHILD_WORKSPACE') {
    return <TreeStructureIcon className="h-3 w-3 shrink-0 text-violet-500" />;
  }
  return null;
}

function PrLink({ prNumber, onOpenPr }: { prNumber: number; onOpenPr?: () => void }) {
  const content = (
    <>
      <GitPullRequestIcon className="h-2.5 w-2.5" />
      <span>#{prNumber}</span>
    </>
  );
  if (onOpenPr) {
    return (
      <button
        type="button"
        className="flex items-center gap-0.5 hover:text-foreground"
        onPointerUp={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenPr();
        }}
      >
        {content}
      </button>
    );
  }
  return <span className="flex items-center gap-0.5">{content}</span>;
}

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
  const statusReason = getVisibleWorkspaceStatusReason(workspace.statusReason);

  return (
    <div className="flex flex-col gap-0.5 min-w-0 w-full">
      <div className="flex items-center gap-2 min-w-0">
        <WorkspaceStatusIcon
          pendingRequestType={workspace.pendingRequestType}
          isWorking={workspace.isWorking}
        />
        <CreationSourceIcon creationSource={workspace.creationSource} />
        <span className="truncate text-sm">{workspace.name}</span>
      </div>
      {hasMetaRow && (
        <div className="grid grid-cols-[1fr_auto_3rem] items-center gap-x-2 pl-[calc(0.5rem+8px)] text-[11px] text-muted-foreground min-w-0">
          <span className="flex items-center gap-1 min-w-0 truncate">
            {showBranch && (
              <>
                <GitBranchIcon className="h-2.5 w-2.5 shrink-0" />
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
            {showPR && workspace.prNumber != null && (
              <PrLink prNumber={workspace.prNumber} onOpenPr={onOpenPr} />
            )}
          </span>
        </div>
      )}
      {statusReason && (
        <div className="pl-[calc(0.5rem+8px)] text-[11px] text-muted-foreground truncate">
          {statusReason.label}
        </div>
      )}
      {hasIssue && (
        <div className="pl-[calc(0.5rem+8px)]">
          {onOpenIssue ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
              onPointerUp={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenIssue();
              }}
            >
              <DotOutlineIcon className="h-2.5 w-2.5" />
              {issueLabel}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <DotOutlineIcon className="h-2.5 w-2.5" />
              {issueLabel}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
