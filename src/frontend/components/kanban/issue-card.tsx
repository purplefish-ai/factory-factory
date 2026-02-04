import { CircleDot, Play, User } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { trpc } from '@/frontend/lib/trpc';
import type { GitHubIssue } from './kanban-context';

interface IssueCardProps {
  issue: GitHubIssue;
  projectId: string;
  projectSlug: string;
}

export function IssueCard({ issue, projectId, projectSlug }: IssueCardProps) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const createWorkspaceMutation = trpc.workspace.create.useMutation({
    onSuccess: (workspace) => {
      // Invalidate workspace queries to refresh the board
      utils.workspace.listWithKanbanState.invalidate({ projectId });
      // Navigate to the new workspace
      navigate(`/projects/${projectSlug}/workspaces/${workspace.id}`);
    },
  });

  const handleStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    createWorkspaceMutation.mutate({
      projectId,
      name: issue.title,
      description: `GitHub Issue #${issue.number}\n\n${issue.body?.slice(0, 500) ?? ''}`,
    });
  };

  const handleOpenIssue = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(issue.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <Card className="cursor-pointer hover:border-primary/50 transition-colors overflow-hidden border-dashed">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-medium leading-tight line-clamp-2">
            {issue.title}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <button
            type="button"
            onClick={handleOpenIssue}
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            <CircleDot className="h-3 w-3 text-green-500" />
            <span>#{issue.number}</span>
          </button>
          <span className="text-muted-foreground/50">|</span>
          <span className="inline-flex items-center gap-1">
            <User className="h-3 w-3" />
            {issue.author.login}
          </span>
        </div>

        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={handleStart}
          disabled={createWorkspaceMutation.isPending}
        >
          <Play className="h-3 w-3 mr-1" />
          {createWorkspaceMutation.isPending ? 'Starting...' : 'Start'}
        </Button>
      </CardContent>
    </Card>
  );
}
