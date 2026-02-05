import type {
  CIStatus,
  KanbanColumn,
  RatchetState,
  Workspace,
  WorkspaceStatus,
} from '@prisma-gen/browser';
import { Archive, GitBranch, GitPullRequest } from 'lucide-react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { WorkspaceStatusBadge } from '@/components/workspace/workspace-status-badge';
import { CIFailureWarning } from '@/frontend/components/ci-failure-warning';
import { cn } from '@/lib/utils';

export interface WorkspaceWithKanban extends Workspace {
  kanbanColumn: KanbanColumn | null;
  isWorking: boolean;
  isArchived?: boolean;
  ratchetState: RatchetState;
}

interface KanbanCardProps {
  workspace: WorkspaceWithKanban;
  projectSlug: string;
}

function CardStatusIndicator({
  isArchived,
  isWorking,
  status,
  errorMessage,
}: {
  isArchived: boolean;
  isWorking: boolean;
  status: WorkspaceStatus;
  errorMessage: string | null;
}) {
  if (isArchived) {
    return (
      <Badge variant="outline" className="shrink-0 text-[10px] gap-1">
        <Archive className="h-2.5 w-2.5" />
        Archived
      </Badge>
    );
  }

  if (isWorking) {
    return (
      <span className="flex items-center gap-1 text-xs text-brand shrink-0">
        <span className="h-2 w-2 rounded-full bg-brand animate-pulse" />
        Working
      </span>
    );
  }

  return <WorkspaceStatusBadge status={status} errorMessage={errorMessage} />;
}

export function KanbanCard({ workspace, projectSlug }: KanbanCardProps) {
  const showPR = workspace.prState !== 'NONE' && workspace.prNumber && workspace.prUrl;
  const isArchived = workspace.isArchived || workspace.status === 'ARCHIVED';
  // Check if workspace is in DONE column (merged PR). Exclude DONE from ratchet animation.
  const isDone = workspace.kanbanColumn === 'DONE';
  const isRatchetActive = !isDone && workspace.ratchetState && workspace.ratchetState !== 'IDLE';

  return (
    <Link to={`/projects/${projectSlug}/workspaces/${workspace.id}`}>
      <Card
        className={cn(
          'cursor-pointer hover:border-primary/50 transition-colors',
          !isRatchetActive && 'overflow-hidden',
          workspace.isWorking && 'border-brand/50 bg-brand/5',
          isArchived && 'opacity-60 border-dashed',
          isRatchetActive && 'ratchet-active'
        )}
      >
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-sm font-medium leading-tight line-clamp-2">
              {workspace.name}
            </CardTitle>
            <CardStatusIndicator
              isArchived={isArchived}
              isWorking={workspace.isWorking}
              status={workspace.status}
              errorMessage={workspace.initErrorMessage}
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {(workspace.branchName || showPR) && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground min-w-0">
              {workspace.branchName && (
                <>
                  <GitBranch className="h-3 w-3 shrink-0" />
                  <span className="font-mono truncate">{workspace.branchName}</span>
                </>
              )}
              {showPR && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    window.open(workspace.prUrl as string, '_blank', 'noopener,noreferrer');
                  }}
                  className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                >
                  <GitPullRequest className="h-3 w-3" />
                  <span>#{workspace.prNumber}</span>
                </button>
              )}
            </div>
          )}

          {showPR && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <CIFailureWarning
                ciStatus={workspace.prCiStatus as CIStatus}
                prUrl={workspace.prUrl}
                size="sm"
              />
            </div>
          )}

          {workspace.description && (
            <p className="text-xs text-muted-foreground line-clamp-2">{workspace.description}</p>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
