import { useCallback, useEffect, useMemo } from 'react';
import { getSubagentIconIndices } from '@/client/lib/subagent-icon-indices';
import { trpc } from '@/client/lib/trpc';
import type { ChatMessage } from '@/lib/chat-protocol';
import type { SubagentListState } from './subagent-list';
import { getNextSubagentPageParam, getSubagentListError } from './subagent-pagination';
import { isActiveSubagent } from './subagent-status';
import { createSubagentTimelineEvents, mergeSubagentTimeline } from './subagent-timeline';
import type { SubagentListItem, SubagentListResult } from './types';
import { useSubagentInvalidation } from './use-subagent-invalidation';

function collectSubagents(pages: SubagentListResult[] = []): SubagentListItem[] {
  const byId = new Map<string, SubagentListItem>();
  for (const page of pages) {
    if (page.supported) {
      for (const subagent of page.subagents) {
        if (!byId.has(subagent.id)) {
          byId.set(subagent.id, subagent);
        }
      }
    }
  }
  return [...byId.values()];
}

function getListState(
  pages: SubagentListResult[] | undefined,
  subagents: SubagentListItem[],
  error: { message: string; onRetry: () => void } | null,
  pagination: Pick<
    Extract<SubagentListState, { kind: 'ready' }>,
    'hasMore' | 'loadingMore' | 'onLoadMore'
  >
): SubagentListState {
  if (pages?.some((page) => !page.supported)) {
    return { kind: 'unsupported' };
  }
  if (!pages?.length) {
    return error ? { kind: 'error', ...error } : { kind: 'loading' };
  }
  return { kind: 'ready', subagents, ...pagination, error: error ?? undefined };
}

/** Share the Sessions panel's provider query and live invalidations. */
export function useSubagentTimelineMessages(
  messages: ChatMessage[],
  sessionId: string | null,
  enabled: boolean,
  loading = false
) {
  const queryEnabled = useSubagentInvalidation(
    sessionId,
    Boolean(sessionId && enabled && !loading)
  );
  const query = trpc.session.listSubagents.useInfiniteQuery(
    { sessionId: sessionId ?? '', cursor: null, limit: 100 },
    {
      enabled: queryEnabled,
      refetchOnMount: 'always',
      getNextPageParam: getNextSubagentPageParam,
    }
  );
  const { hasNextPage, isFetching, fetchNextPage, refetch } = query;
  const errorMessage = getSubagentListError(query)?.message;
  useEffect(() => {
    if (queryEnabled && hasNextPage && !isFetching && !errorMessage) {
      void fetchNextPage();
    }
  }, [queryEnabled, hasNextPage, isFetching, errorMessage, fetchNextPage]);
  const onRetry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const error = useMemo(
    () =>
      errorMessage ? { message: 'Some sub-agent activity could not be loaded.', onRetry } : null,
    [errorMessage, onRetry]
  );

  const pages = query.data?.pages;
  const subagents = useMemo(() => {
    if (!sessionId || pages?.some((page) => !page.supported)) {
      return [];
    }
    return collectSubagents(pages);
  }, [pages, sessionId]);
  const events = useMemo(() => createSubagentTimelineEvents(subagents), [subagents]);
  const runningSubagentIconIndices = useMemo(() => {
    // Earlier-created agents can arrive on later pages and shift every index.
    if (hasNextPage || errorMessage) {
      return [];
    }
    const indices = getSubagentIconIndices(subagents);
    const activeIds = new Set(subagents.filter(isActiveSubagent).map((agent) => agent.id));
    return [...indices].filter(([id]) => activeIds.has(id)).map(([, index]) => index);
  }, [subagents, hasNextPage, errorMessage]);
  const timelineMessages = useMemo(
    () => mergeSubagentTimeline(messages, events),
    [messages, events]
  );
  const subagentListState = getListState(pages, subagents, error, {
    hasMore: hasNextPage,
    loadingMore: isFetching,
    onLoadMore: () => {
      void fetchNextPage();
    },
  });
  return {
    messages: timelineMessages,
    error,
    runningSubagentIconIndices,
    subagents,
    subagentListState,
  };
}
