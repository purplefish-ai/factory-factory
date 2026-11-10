import { DotOutlineIcon } from '@phosphor-icons/react/dist/csr/DotOutline';
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play';
import { UserIcon } from '@phosphor-icons/react/dist/csr/User';
import { useState } from 'react';
import type { NormalizedIssue } from '@/client/lib/issue-normalization';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { IssueLaunchSheet } from './issue-launch-sheet';

interface IssueCardProps {
  issue: NormalizedIssue;
  projectId: string;
}

export function IssueCard({ issue, projectId }: IssueCardProps) {
  const [launchSheetOpen, setLaunchSheetOpen] = useState(false);

  const handleStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setLaunchSheetOpen(true);
  };

  const handleCardClick = () => {
    setLaunchSheetOpen(true);
  };

  return (
    <>
      <Card
        onClick={handleCardClick}
        data-testid="issue-card"
        className="cursor-pointer hover:border-primary/50 transition-colors overflow-hidden border-dashed"
      >
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium leading-tight line-clamp-2">
            <button
              type="button"
              className="rounded-sm text-left hover:underline focus-ring"
              onClick={handleCardClick}
              aria-label={`Start ${issue.title}`}
            >
              {issue.title}
            </button>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-2xs text-muted-foreground min-w-0">
              <span className="inline-flex items-center gap-1 shrink-0">
                <DotOutlineIcon className="h-3 w-3 text-success" />
                <span>{issue.displayId}</span>
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 truncate">
                    <UserIcon className="h-3 w-3 shrink-0" />
                    {issue.author}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Opened by {issue.author} on {new Date(issue.createdAt).toLocaleDateString()}
                </TooltipContent>
              </Tooltip>
            </div>
            <a
              onClick={(event) => event.stopPropagation()}
              href={issue.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:underline"
              aria-label={`Open ${issue.displayId} externally`}
            >
              Open issue ↗
            </a>
            <Button size="xs" variant="outline" className="shrink-0" onClick={handleStart}>
              <PlayIcon />
              Start
            </Button>
          </div>
        </CardContent>
      </Card>
      {launchSheetOpen ? (
        <IssueLaunchSheet
          issue={issue}
          projectId={projectId}
          open={launchSheetOpen}
          onOpenChange={setLaunchSheetOpen}
        />
      ) : null}
    </>
  );
}
