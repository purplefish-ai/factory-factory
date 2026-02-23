import { CircleDot, Play, User } from 'lucide-react';
import { useEffect, useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { createOptimisticWorkspaceCacheData } from '@/client/lib/workspace-cache-helpers';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RatchetToggleButton } from '@/components/workspace';
import type { KanbanIssue } from './kanban-context';

interface IssueCardProps {
  issue: KanbanIssue;
  projectId: string;
  onClick?: () => void;
}

export function IssueCard({ issue, projectId, onClick }: IssueCardProps) {
  const utils = trpc.useUtils();
  const { data: userSettings, isLoading: isLoadingSettings } = trpc.userSettings.get.useQuery();
  const [ratchetEnabled, setRatchetEnabled] = useState(false);
  const ratchetPreferenceKey = `kanban:issue-ratchet:${projectId}:${issue.id}`;

  useEffect(() => {
    if (userSettings?.ratchetEnabled === undefined) {
      return;
    }
    try {
      const savedPreference = window.localStorage.getItem(ratchetPreferenceKey);
      if (savedPreference === 'true' || savedPreference === 'false') {
        setRatchetEnabled(savedPreference === 'true');
        return;
      }
    } catch {
      // Ignore localStorage failures and fall back to admin default.
    }
    setRatchetEnabled(userSettings.ratchetEnabled);
  }, [ratchetPreferenceKey, userSettings?.ratchetEnabled]);

  const createWorkspaceMutation = trpc.workspace.create.useMutation({
    onSuccess: (workspace) => {
      // Optimistically populate the workspace detail query cache so the status
      // is immediately visible when navigating to the detail page
      utils.workspace.get.setData({ id: workspace.id }, (old) => {
        // If there's already data (shouldn't happen for a new workspace), keep it
        if (old) {
          return old;
        }

        return createOptimisticWorkspaceCacheData(workspace);
      });

      // Invalidate workspace queries to refresh the board
      utils.workspace.listWithKanbanState.invalidate({ projectId });
    },
  });

  const handleStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (issue.provider === 'linear' && issue.linearIssueId && issue.linearIssueIdentifier) {
      createWorkspaceMutation.mutate({
        type: 'LINEAR_ISSUE',
        projectId,
        issueId: issue.linearIssueId,
        issueIdentifier: issue.linearIssueIdentifier,
        issueUrl: issue.url,
        name: issue.title,
        ratchetEnabled,
      });
    } else if (issue.githubIssueNumber) {
      createWorkspaceMutation.mutate({
        type: 'GITHUB_ISSUE',
        projectId,
        issueNumber: issue.githubIssueNumber,
        issueUrl: issue.url,
        name: issue.title,
        ratchetEnabled,
      });
    }
  };

  const handleOpenIssue = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(issue.url, '_blank', 'noopener,noreferrer');
  };

  const handleCardClick = () => {
    onClick?.();
  };

  return (
    <Card
      className="cursor-pointer hover:border-primary/50 transition-colors overflow-hidden border-dashed"
      onClick={handleCardClick}
    >
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium leading-tight line-clamp-2">
          {issue.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground min-w-0">
            <RatchetToggleButton
              enabled={ratchetEnabled}
              state="IDLE"
              className="h-5 w-5 shrink-0"
              stopPropagation
              disabled={isLoadingSettings || createWorkspaceMutation.isPending}
              onToggle={(enabled) => {
                setRatchetEnabled(enabled);
                try {
                  window.localStorage.setItem(ratchetPreferenceKey, String(enabled));
                } catch {
                  // Ignore localStorage failures without interrupting the toggle.
                }
              }}
            />
            <button
              type="button"
              onClick={handleOpenIssue}
              className="inline-flex items-center gap-1 hover:text-foreground shrink-0"
            >
              <CircleDot className="h-3 w-3 text-green-500" />
              <span>{issue.displayId}</span>
            </button>
            <span className="inline-flex items-center gap-1 truncate">
              <User className="h-3 w-3 shrink-0" />
              {issue.author}
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
