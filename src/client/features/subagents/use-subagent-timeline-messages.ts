import { useEffect, useMemo } from 'react';
import { trpc } from '@/client/lib/trpc';
import type { ChatMessage } from '@/lib/chat-protocol';
import { getNextSubagentPageParam } from './subagent-pagination';
import { createSubagentTimelineEvents, mergeSubagentTimeline } from './subagent-timeline';
import { useSubagentInvalidation } from './use-subagent-invalidation';

/** Share the Sessions panel's provider query and live invalidations. */
export function useSubagentTimelineMessages(
  messages: ChatMessage[],
  sessionId: string | null,
  enabled: boolean,
  loading = false
): ChatMessage[] {
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
  const { hasNextPage, isFetching, error, fetchNextPage } = query;
  useEffect(() => {
    if (queryEnabled && hasNextPage && !isFetching && !error) {
      void fetchNextPage();
    }
  }, [queryEnabled, hasNextPage, isFetching, error, fetchNextPage]);

  const pages = query.data?.pages;
  const events = useMemo(() => {
    if (!sessionId || pages?.some((page) => !page.supported)) {
      return [];
    }
    return createSubagentTimelineEvents(
      pages?.flatMap((page) => (page.supported ? page.subagents : [])) ?? []
    );
  }, [pages, sessionId]);
  return useMemo(() => mergeSubagentTimeline(messages, events), [messages, events]);
}
