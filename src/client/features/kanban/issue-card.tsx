import { DotOutlineIcon } from '@phosphor-icons/react/dist/csr/DotOutline';
import { GithubLogoIcon } from '@phosphor-icons/react/dist/csr/GithubLogo';
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
              className="inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-ring [@media(any-pointer:coarse)]:min-h-9 [@media(any-pointer:coarse)]:min-w-9"
              aria-label={`Open ${issue.displayId} externally`}
            >
              {issue.provider === 'github' ? (
                <GithubLogoIcon className="h-4 w-4" aria-hidden="true" />
              ) : (
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                  <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
                </svg>
              )}
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
