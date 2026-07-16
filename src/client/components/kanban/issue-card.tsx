import { DotOutlineIcon, PlayIcon, UserIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import type { NormalizedIssue } from '@/client/lib/issue-normalization';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { IssueLaunchSheet } from './issue-launch-sheet';

interface IssueCardProps {
  issue: NormalizedIssue;
  projectId: string;
  onClick?: () => void;
}

export function IssueCard({ issue, projectId, onClick }: IssueCardProps) {
  const [launchSheetOpen, setLaunchSheetOpen] = useState(false);

  const handleStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setLaunchSheetOpen(true);
  };

  const handleCardClick = () => {
    onClick?.();
  };

  return (
    <>
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
              <span className="inline-flex items-center gap-1 shrink-0">
                <DotOutlineIcon className="h-3 w-3 text-green-500" />
                <span>{issue.displayId}</span>
              </span>
              <span className="inline-flex items-center gap-1 truncate">
                <UserIcon className="h-3 w-3 shrink-0" />
                {issue.author}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs shrink-0"
              onClick={handleStart}
            >
              <PlayIcon className="h-3 w-3 mr-1" />
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
