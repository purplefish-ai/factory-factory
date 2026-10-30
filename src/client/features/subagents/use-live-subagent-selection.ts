import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeToSubagentChanges } from '@/client/lib/subagent-events';
import { getSubagentIconIndices } from '@/client/lib/subagent-icon-indices';
import { createTrailingRefresh } from '@/client/lib/trailing-refresh';
import { trpc } from '@/client/lib/trpc';
import { getNextSubagentPageParam } from './subagent-pagination';
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
  return useLiveSubagent(selection).selection;
}

export function useLiveSubagent(selection: SubagentSelection): {
  selection: SubagentSelection;
  iconIndex: number;
} {
  const query = trpc.session.listSubagents.useInfiniteQuery(
    { sessionId: selection.parentSessionId, cursor: null, limit: 100 },
    {
      refetchOnMount: false,
      getNextPageParam: getNextSubagentPageParam,
    }
  );
  const mountDataUpdatedAt = useRef(query.dataUpdatedAt);
  const hadCachedDataAtMount = useRef(query.data !== undefined);
  const [successfulRefetchDataUpdatedAt, setSuccessfulRefetchDataUpdatedAt] = useState(0);

  const subagents =
    query.data?.pages.filter((page) => page.supported).flatMap((page) => page.subagents) ?? [];
  const refreshed = subagents.find((candidate) => candidate.id === selection.subagent.id);
  const iconIndex =
    getSubagentIconIndices(refreshed ? subagents : [...subagents, selection.subagent]).get(
      selection.subagent.id
    ) ?? 0;
  const candidateWasCachedAtMount = useRef(refreshed !== undefined);
  const querySnapshot = useRef({
    dataUpdatedAt: query.dataUpdatedAt,
    loadedPageCount: query.data?.pages.length ?? 0,
  });
  const automaticRefetchSnapshot = useRef<{
    dataUpdatedAt: number;
    loadedPageCount: number;
  } | null>(null);
  querySnapshot.current = {
    dataUpdatedAt: query.dataUpdatedAt,
    loadedPageCount: query.data?.pages.length ?? 0,
  };

  const refetch = useCallback(async () => {
    const before = querySnapshot.current;
    const result = await query.refetch();
    const resultPageCount = result.data?.pages.length ?? 0;
    // The query cache is shared, so a next-page fetch can advance dataUpdatedAt
    // without refreshing a candidate that was already cached.
    if (
      result.isSuccess &&
      result.dataUpdatedAt > before.dataUpdatedAt &&
      resultPageCount === before.loadedPageCount
    ) {
      setSuccessfulRefetchDataUpdatedAt((current) => Math.max(current, result.dataUpdatedAt));
    }
  }, [query.refetch]);

  useEffect(() => {
    if (query.isRefetching) {
      automaticRefetchSnapshot.current ??= querySnapshot.current;
      return;
    }
    const before = automaticRefetchSnapshot.current;
    if (before === null) {
      return;
    }
    automaticRefetchSnapshot.current = null;
    const current = querySnapshot.current;
    if (
      query.isSuccess &&
      current.dataUpdatedAt > before.dataUpdatedAt &&
      current.loadedPageCount === before.loadedPageCount
    ) {
      setSuccessfulRefetchDataUpdatedAt((timestamp) => Math.max(timestamp, current.dataUpdatedAt));
    }
  }, [query.isRefetching, query.isSuccess]);

  const startedMountRefetch = useRef(false);
  useEffect(() => {
    if (startedMountRefetch.current || !hadCachedDataAtMount.current) {
      return;
    }
    startedMountRefetch.current = true;
    void refetch();
  }, [refetch]);

  useEffect(() => {
    // Change bursts run one refetch at a time plus one trailing refetch.
    const refreshOnChange = createTrailingRefresh(refetch);
    const unsubscribe = subscribeToSubagentChanges((detail) => {
      if (
        detail.sessionId === selection.parentSessionId &&
        detail.subagentId === selection.subagent.id
      ) {
        refreshOnChange.trigger();
      }
    });
    return () => {
      unsubscribe();
      refreshOnChange.dispose();
    };
  }, [refetch, selection.parentSessionId, selection.subagent.id]);

  const loadedPageCount = query.data?.pages.length ?? 0;
  const hasSuccessfulPostMountFetch = candidateWasCachedAtMount.current
    ? successfulRefetchDataUpdatedAt > mountDataUpdatedAt.current
    : query.isFetchedAfterMount && query.dataUpdatedAt > mountDataUpdatedAt.current;

  useEffect(() => {
    // Icon assignment needs the entire session, even after the selected child is found.
    if (
      loadedPageCount === 0 ||
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
  ]);

  return {
    selection:
      refreshed &&
      isProvenAtLeastAsFresh(selection.subagent, refreshed, hasSuccessfulPostMountFetch)
        ? { ...selection, subagent: refreshed }
        : selection,
    iconIndex,
  };
}
