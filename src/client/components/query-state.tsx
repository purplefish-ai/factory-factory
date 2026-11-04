import type { ReactNode } from 'react';
import { Loading } from './loading';
import { QueryErrorState } from './query-error-state';

/** The subset of a TanStack/tRPC query result that `QueryState` reads. */
export interface QueryStateQuery<TData> {
  data: TData | undefined;
  error: { message: string } | null;
  isFetching: boolean;
  refetch: () => unknown;
}

interface QueryStateProps<TData> {
  query: QueryStateQuery<TData>;
  /** Error title, e.g. "Couldn't load screenshots". */
  errorTitle: string;
  /** Rendered with the data when it is present and not empty. */
  children: (data: TData) => ReactNode;
  /** Treat loaded data as empty, e.g. `(data) => data.items.length === 0`. */
  isEmpty?: (data: TData) => boolean;
  /** Rendered when `isEmpty` returns true; usually an `EmptyState`. */
  empty?: ReactNode;
  /** Replaces the default `Loading`, e.g. with a `Skeleton` of the content. */
  loading?: ReactNode;
  /** Message for the default `Loading`. */
  loadingMessage?: string;
  /** `compact` sizes the default loading state for side panels. */
  size?: 'default' | 'compact';
  /** Applied to the default loading and error states. */
  className?: string;
}

/**
 * One switch for the loading, error-with-retry, empty and content branches of
 * a query, following the rules in docs/architecture/client-loading.md.
 */
export function QueryState<TData>({
  query,
  errorTitle,
  children,
  isEmpty,
  empty = null,
  loading,
  loadingMessage,
  size = 'default',
  className,
}: QueryStateProps<TData>) {
  // Cached data wins over a background refetch error, and an error without
  // data wins over loading so a failed query never reads as an empty one.
  const { data, error } = query;
  if (data !== undefined) {
    return isEmpty?.(data) ? empty : children(data);
  }
  if (error) {
    return (
      <QueryErrorState
        title={errorTitle}
        error={error}
        onRetry={() => {
          void query.refetch();
        }}
        isRetrying={query.isFetching}
        className={className}
      />
    );
  }
  return loading ?? <Loading message={loadingMessage} size={size} className={className} />;
}
