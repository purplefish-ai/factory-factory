import { formatDistanceToNowStrict } from 'date-fns';
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export const githubPreviewQueryOptions = {
  staleTime: 60_000,
  retry: false,
  refetchOnWindowFocus: false,
} as const;

function formatCreatedAt(createdAt: string) {
  const date = new Date(createdAt);
  return Math.abs(Date.now() - date.getTime()) <= 5000
    ? 'now'
    : formatDistanceToNowStrict(date, { addSuffix: true });
}

export function GitHubPreviewFrame({
  repo,
  number,
  kind,
  data,
  state,
  icon,
  isError = false,
  children,
}: {
  repo: string;
  number: number;
  kind: 'issue' | 'pull request';
  data?: { title: string; author: { login: string } | null; createdAt: string };
  state: { label: string; color: string } | null;
  icon: ReactNode;
  isError?: boolean;
  children?: ReactNode;
}) {
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
            {icon}
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
            {children}
          </div>
        </>
      ) : (
        <div className="text-muted-foreground" role="status">
          {isError ? (
            `Preview unavailable. Open the link to view this ${kind}.`
          ) : (
            <span className="inline-flex items-center gap-2">
              <Spinner className="size-3" aria-hidden="true" />
              {`Loading ${kind}…`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Children mount on open, so domain queries remain lazy. */
export function GitHubPreviewTooltip({
  link,
  children,
}: {
  link: ReactElement<ComponentPropsWithoutRef<'a'>>;
  children: ReactNode;
}) {
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
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
