import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleIcon } from '@phosphor-icons/react/dist/csr/Circle';
import { formatDistanceToNowStrict } from 'date-fns';
import type { ComponentPropsWithoutRef, ReactElement } from 'react';
import { trpc } from '@/client/lib/trpc';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { type GitHubIssuePreview, parseGitHubIssueLink } from '@/shared/github-issue-preview';

const ISSUE_STATES = {
  OPEN: { label: 'Open', color: 'bg-green-500/15 text-green-600 dark:text-green-400' },
  CLOSED: { label: 'Closed', color: 'bg-purple-500/15 text-purple-600 dark:text-purple-400' },
};

function formatCreatedAt(createdAt: string) {
  const date = new Date(createdAt);
  return Math.abs(Date.now() - date.getTime()) <= 5000
    ? 'now'
    : formatDistanceToNowStrict(date, { addSuffix: true });
}

export function GitHubIssuePreviewCard({
  repo,
  number,
  data,
  isError = false,
}: {
  repo: string;
  number: number;
  data?: GitHubIssuePreview;
  isError?: boolean;
}) {
  const state = data ? ISSUE_STATES[data.state] : null;
  const Icon = data?.state === 'CLOSED' ? CheckCircleIcon : CircleIcon;
  return (
    <div className="space-y-3 text-sm leading-normal">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {state && (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-1 font-medium',
              state.color
            )}
          >
            <Icon className="size-3.5" />
            {state.label}
          </span>
        )}
        <span className="min-w-0 break-all">
          {repo} #{number}
        </span>
        {data && (
          <time dateTime={data.createdAt} title={new Date(data.createdAt).toLocaleString()}>
            {formatCreatedAt(data.createdAt)}
          </time>
        )}
      </div>
      {data ? (
        <>
          <div className="break-words text-base font-medium text-popover-foreground">
            {data.title}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 break-all">{data.author?.login ?? 'Deleted user'}</span>
          </div>
        </>
      ) : (
        <div className="text-muted-foreground" role="status">
          {isError ? 'Preview unavailable. Open the link to view this issue.' : 'Loading issue…'}
        </div>
      )}
    </div>
  );
}

function IssuePreview({ repo, number }: { repo: string; number: number }) {
  const { data, isError } = trpc.github.getIssuePreview.useQuery(
    { repo: repo.toLowerCase(), number },
    {
      staleTime: 60_000,
      retry: false,
      refetchOnWindowFocus: false,
    }
  );
  return <GitHubIssuePreviewCard repo={repo} number={number} data={data} isError={isError} />;
}

export function GitHubIssueLink({ link }: { link: ReactElement<ComponentPropsWithoutRef<'a'>> }) {
  const issue = link.props.href ? parseGitHubIssueLink(link.props.href) : null;
  if (!issue) {
    return link;
  }
  return (
    <TooltipProvider delayDuration={350}>
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent
          align="start"
          side="bottom"
          sideOffset={8}
          showArrow={false}
          className="not-prose w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-4 text-left text-popover-foreground shadow-xl text-wrap"
        >
          <IssuePreview {...issue} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
