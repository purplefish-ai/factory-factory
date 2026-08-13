import { useEffect, useRef } from 'react';
import { subscribeToSubagentChanges } from '@/client/lib/subagent-events';
import { trpc } from '@/client/lib/trpc';
import type { SubagentSelection } from './types';

type SubagentStatus = SubagentSelection['subagent']['status'];

const TERMINAL_STATUSES: ReadonlySet<SubagentStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

function validTimestamp(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function isProvenAtLeastAsFresh(
  stored: SubagentSelection['subagent'],
  candidate: SubagentSelection['subagent'],
  hasSuccessfulPostMountFetch: boolean
): boolean {
  if (TERMINAL_STATUSES.has(stored.status) && !TERMINAL_STATUSES.has(candidate.status)) {
    return false;
  }
  const storedTimestamp = validTimestamp(stored.updatedAt);
  const candidateTimestamp = validTimestamp(candidate.updatedAt);
  if (
    (stored.updatedAt !== null && storedTimestamp === null) ||
    (candidate.updatedAt !== null && candidateTimestamp === null)
  ) {
    return false;
  }
  if (storedTimestamp === null || candidateTimestamp === null) {
    return hasSuccessfulPostMountFetch;
  }
  return candidateTimestamp >= storedTimestamp;
}

export function useLiveSubagentSelection(selection: SubagentSelection): SubagentSelection {
  const query = trpc.session.listSubagents.useInfiniteQuery(
    { sessionId: selection.parentSessionId, cursor: null, limit: 100 },
    {
      refetchOnMount: 'always',
      getNextPageParam: (lastPage) =>
        lastPage.supported ? (lastPage.nextCursor ?? undefined) : undefined,
    }
  );
  const mountDataUpdatedAt = useRef(query.dataUpdatedAt);

  useEffect(
    () =>
      subscribeToSubagentChanges((detail) => {
        if (
          detail.sessionId === selection.parentSessionId &&
          detail.subagentId === selection.subagent.id
        ) {
          void query.refetch();
        }
      }),
    [query.refetch, selection.parentSessionId, selection.subagent.id]
  );

  const refreshed = query.data?.pages
    .filter((page) => page.supported)
    .flatMap((page) => page.subagents)
    .find((candidate) => candidate.id === selection.subagent.id);
  const loadedPageCount = query.data?.pages.length ?? 0;
  const hasSuccessfulPostMountFetch =
    query.isFetchedAfterMount && query.dataUpdatedAt > mountDataUpdatedAt.current;

  useEffect(() => {
    if (
      loadedPageCount === 0 ||
      refreshed ||
      !query.hasNextPage ||
      query.isFetching ||
      query.isFetchNextPageError
    ) {
      return;
    }
    void query.fetchNextPage();
  }, [
    loadedPageCount,
    query.fetchNextPage,
    query.hasNextPage,
    query.isFetchNextPageError,
    query.isFetching,
    refreshed,
  ]);

  return refreshed &&
    isProvenAtLeastAsFresh(selection.subagent, refreshed, hasSuccessfulPostMountFetch)
    ? { ...selection, subagent: refreshed }
    : selection;
}
