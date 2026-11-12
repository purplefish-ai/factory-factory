import type { ReactNode } from 'react';
import { EmptyState } from '@/client/components/empty-state';
import { QueryErrorState, QueryRefreshError } from '@/client/components/query-error-state';
import { formatDateTime, toDateTimeIso } from '@/client/lib/date-time';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { describeEventReason } from './event-history-reasons';

/** The parts of a paged history query the frame reads. */
export interface EventHistoryQuery {
  error: { message: string } | null;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
  refetch: () => Promise<unknown>;
}

/**
 * Loading, error, empty and "Load more" states shared by the Runs and Events
 * views. Rows stay listed under a failed refresh or a failed next page.
 */
export function EventHistoryFrame({
  title,
  noun,
  emptyDescription,
  query,
  count,
  children,
}: {
  title: string;
  /** Plural, lower case: "runs" or "events". */
  noun: string;
  emptyDescription: string;
  query: EventHistoryQuery;
  /** Rows loaded so far; undefined until the first page arrives. */
  count: number | undefined;
  children: ReactNode;
}) {
  const { error } = query;
  const retry = () => {
    void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch());
  };
  return (
    <section aria-label={title} className="min-w-0 space-y-4">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">Newest first</p>
      </div>
      {error && count === undefined ? (
        <QueryErrorState
          title={`Couldn't load ${noun}`}
          error={error}
          onRetry={retry}
          isRetrying={query.isFetching}
          className="p-0"
        />
      ) : null}
      {error && count !== undefined ? (
        <QueryRefreshError
          title={
            query.isFetchNextPageError ? `Couldn't load more ${noun}` : `Couldn't refresh ${noun}`
          }
          error={error}
          onRetry={retry}
          isRetrying={query.isFetching}
          className="rounded-lg border"
        />
      ) : null}
      {/* Unresolved, including a paused offline read, until rows or an error arrive. */}
      {count === undefined && !error && (
        <div role="status" className="space-y-2">
          <span className="sr-only">Loading {noun}…</span>
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
        </div>
      )}
      {/* A loaded empty page stays visible under a failed refresh notice. */}
      {count === 0 && (
        <EmptyState
          title={`No ${noun} yet`}
          description={emptyDescription}
          className="rounded-lg border border-dashed"
        />
      )}
      {count !== undefined && count > 0 && (
        <div className="divide-y rounded-lg border">{children}</div>
      )}
      {query.hasNextPage && !query.isFetchNextPageError && (
        <Button
          variant="outline"
          size="sm"
          pending={query.isFetchingNextPage}
          pendingLabel={`Loading more ${noun}…`}
          onClick={() => void query.fetchNextPage()}
        >
          Load more {noun}
        </Button>
      )}
    </section>
  );
}

/** A stored reason as a readable phrase, with the code kept in its title for support. */
export function EventReason({ code, fallback }: { code: string | null; fallback?: string }) {
  const phrase = describeEventReason(code) ?? fallback;
  if (!phrase) {
    return null;
  }
  return (
    <p className="break-words" title={code ?? undefined}>
      {phrase}
    </p>
  );
}

/** A timestamp with its full precision on hover. */
export function EventTime({ value, prefix }: { value: string; prefix: string }) {
  return (
    <span className="text-muted-foreground">
      {prefix}{' '}
      <time dateTime={toDateTimeIso(value)} title={formatDateTime(value, { precision: 'second' })}>
        {formatDateTime(value)}
      </time>
    </span>
  );
}

/** Support details: identifiers and raw codes, collapsed by default. */
export function EventHistoryDetails({
  rows,
}: {
  rows: ReadonlyArray<readonly [label: string, value: ReactNode]>;
}) {
  return (
    <details className="text-muted-foreground">
      <summary className="cursor-pointer select-none">Details</summary>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt>{label}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
