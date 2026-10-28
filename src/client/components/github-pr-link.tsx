import { GitMergeIcon } from '@phosphor-icons/react/dist/csr/GitMerge';
import { GitPullRequestIcon } from '@phosphor-icons/react/dist/csr/GitPullRequest';
import { formatDistanceToNowStrict } from 'date-fns';
import type { ComponentPropsWithoutRef, ReactElement } from 'react';
import { trpc } from '@/client/lib/trpc';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { type GitHubPRPreview, parseGitHubPRLink } from '@/shared/github-pr-preview';

const PR_STATES = {
  OPEN: { label: 'Open', color: 'bg-green-500/15 text-green-600 dark:text-green-400' },
  MERGED: { label: 'Merged', color: 'bg-purple-500/15 text-purple-600 dark:text-purple-400' },
  CLOSED: { label: 'Closed', color: 'bg-red-500/15 text-red-600 dark:text-red-400' },
  DRAFT: { label: 'Draft', color: 'bg-muted text-muted-foreground' },
};

function formatCreatedAt(createdAt: string) {
  const date = new Date(createdAt);
  return Math.abs(Date.now() - date.getTime()) <= 5000
    ? 'now'
    : formatDistanceToNowStrict(date, { addSuffix: true });
}

export function GitHubPRPreviewCard({
  repo,
  number,
  data,
  isError = false,
}: {
  repo: string;
  number: number;
  data?: GitHubPRPreview;
  isError?: boolean;
}) {
  const state = data
    ? PR_STATES[data.state === 'OPEN' && data.isDraft ? 'DRAFT' : data.state]
    : null;
  const Icon = data?.state === 'MERGED' ? GitMergeIcon : GitPullRequestIcon;
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
            <span className="flex items-center gap-2 tabular-nums">
              <span className="rounded-md bg-muted px-2 py-1">
                <span className="text-green-600 dark:text-green-400">
                  +{data.additions.toLocaleString()}
                </span>{' '}
                <span className="text-red-600 dark:text-red-400">
                  −{data.deletions.toLocaleString()}
                </span>
              </span>
              <span className="rounded-md bg-muted px-2 py-1">
                {data.changedFiles} {data.changedFiles === 1 ? 'file' : 'files'}
              </span>
            </span>
          </div>
        </>
      ) : (
        <div className="text-muted-foreground" role="status">
          {isError
            ? 'Preview unavailable. Open the link to view this pull request.'
            : 'Loading pull request…'}
        </div>
      )}
    </div>
  );
}

function PRPreview({ repo, number }: { repo: string; number: number }) {
  const { data, isError } = trpc.github.getPRPreview.useQuery(
    { repo: repo.toLowerCase(), number },
    {
      staleTime: 60_000,
      retry: false,
      refetchOnWindowFocus: false,
    }
  );
  return <GitHubPRPreviewCard repo={repo} number={number} data={data} isError={isError} />;
}

export function GitHubPRLink({ link }: { link: ReactElement<ComponentPropsWithoutRef<'a'>> }) {
  const pr = link.props.href ? parseGitHubPRLink(link.props.href) : null;
  if (!pr) {
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
          <PRPreview {...pr} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
