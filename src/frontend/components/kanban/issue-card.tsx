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
  const { data: userSettings, isLoading: isLoadingSettings } = trpc.userSettings.get.useQuery();

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
      githubIssueNumber: issue.number,
      githubIssueUrl: issue.url,
      ratchetEnabled: userSettings?.ratchetEnabled ?? false,
    });
  };

  const handleOpenIssue = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(issue.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <Card className="cursor-pointer hover:border-primary/50 transition-colors overflow-hidden border-dashed">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium leading-tight line-clamp-2">
          {issue.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground min-w-0">
            <button
              type="button"
              onClick={handleOpenIssue}
              className="inline-flex items-center gap-1 hover:text-foreground shrink-0"
            >
              <CircleDot className="h-3 w-3 text-green-500" />
              <span>#{issue.number}</span>
            </button>
            <span className="inline-flex items-center gap-1 truncate">
              <User className="h-3 w-3 shrink-0" />
              {issue.author.login}
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs shrink-0"
            onClick={handleStart}
            disabled={createWorkspaceMutation.isPending || isLoadingSettings}
          >
            <Play className="h-3 w-3 mr-1" />
            {createWorkspaceMutation.isPending ? '...' : 'Start'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
