import type { CIStatus, KanbanColumn, PRState, Workspace } from '@prisma-gen/browser';
import { ExternalLink, GitBranch } from 'lucide-react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
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

const prStateBadgeVariants: Record<
  PRState,
  { variant: 'default' | 'secondary' | 'outline' | 'destructive'; label: string }
> = {
  NONE: { variant: 'outline', label: '' },
  DRAFT: { variant: 'secondary', label: 'Draft' },
  OPEN: { variant: 'default', label: 'Open' },
  CHANGES_REQUESTED: { variant: 'destructive', label: 'Changes' },
  APPROVED: { variant: 'default', label: 'Approved' },
  MERGED: { variant: 'secondary', label: 'Merged' },
  CLOSED: { variant: 'outline', label: 'Closed' },
};

export function KanbanCard({ workspace, projectSlug }: KanbanCardProps) {
  const prBadge = prStateBadgeVariants[workspace.prState];
  const showPRBadge = workspace.prState !== 'NONE' && prBadge.label;

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
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
              <GitBranch className="h-3 w-3 shrink-0" />
              <span className="font-mono truncate">{workspace.branchName}</span>
            </div>
          )}

          {showPRBadge && (
            <div className="flex items-center gap-2">
              <Badge
                variant={prBadge.variant}
                className={cn(
                  'text-xs',
                  workspace.prState === 'APPROVED' &&
                    'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30',
                  workspace.prState === 'MERGED' &&
                    'bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/30',
                  workspace.prState === 'CLOSED' &&
                    'bg-gray-500/10 text-gray-500 dark:text-gray-400 border-gray-500/30'
                )}
              >
                {prBadge.label}
              </Badge>
              <CIFailureWarning
                ciStatus={workspace.prCiStatus as CIStatus}
                prUrl={workspace.prUrl}
                size="sm"
              />
              {workspace.prUrl && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    window.open(workspace.prUrl as string, '_blank', 'noopener,noreferrer');
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="h-3 w-3" />
                </button>
              )}
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
