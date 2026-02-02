import type { CIStatus, KanbanColumn, Workspace } from '@prisma-gen/browser';
import { ExternalLink, GitBranch, GitPullRequest } from 'lucide-react';
import { Link } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { WorkspaceStatusBadge } from '@/components/workspace/workspace-status-badge';
import { CIFailureWarning } from '@/frontend/components/ci-failure-warning';
import { cn } from '@/lib/utils';

export interface WorkspaceWithKanban extends Workspace {
  kanbanColumn: KanbanColumn;
  isWorking: boolean;
}

interface KanbanCardProps {
  workspace: WorkspaceWithKanban;
  projectSlug: string;
}

export function KanbanCard({ workspace, projectSlug }: KanbanCardProps) {
  const showPR = workspace.prState !== 'NONE' && workspace.prNumber && workspace.prUrl;

  return (
    <Link to={`/projects/${projectSlug}/workspaces/${workspace.id}`}>
      <Card
        className={cn(
          'cursor-pointer hover:border-primary/50 transition-colors overflow-hidden',
          workspace.isWorking && 'border-brand/50 bg-brand/5'
        )}
      >
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-sm font-medium leading-tight line-clamp-2">
              {workspace.name}
            </CardTitle>
            {workspace.isWorking && (
              <span className="flex items-center gap-1 text-xs text-brand shrink-0">
                <span className="h-2 w-2 rounded-full bg-brand animate-pulse" />
                Working
              </span>
            )}
            {!workspace.isWorking && (
              <WorkspaceStatusBadge
                status={workspace.status}
                errorMessage={workspace.initErrorMessage}
              />
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {workspace.branchName && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
              <GitBranch className="h-3 w-3 shrink-0" />
              <span className="font-mono truncate">{workspace.branchName}</span>
            </div>
          )}

          {showPR && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <GitPullRequest className="h-3 w-3" />
              <span>#{workspace.prNumber}</span>
              <CIFailureWarning
                ciStatus={workspace.prCiStatus as CIStatus}
                prUrl={workspace.prUrl}
                size="sm"
              />
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  window.open(workspace.prUrl as string, '_blank', 'noopener,noreferrer');
                }}
                className="ml-auto h-6 w-6 inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="h-3 w-3" />
              </button>
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
