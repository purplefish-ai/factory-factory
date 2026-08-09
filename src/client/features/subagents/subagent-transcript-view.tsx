import { useCallback, useEffect, useMemo, useRef } from 'react';
import { projectAcpTranscriptUpdates } from '@/client/features/chat';
import { subscribeToSubagentChanges } from '@/client/lib/subagent-events';
import { trpc } from '@/client/lib/trpc';
import {
  SubagentTranscriptContent,
  type SubagentTranscriptState,
} from './subagent-transcript-content';
import type { SubagentSelection } from './types';

export interface SubagentTranscriptViewProps {
  selection: SubagentSelection;
  onBack: () => void;
  workspaceId: string;
}

export function SubagentTranscriptView({
  selection,
  onBack,
  workspaceId,
}: SubagentTranscriptViewProps) {
  const summaryQuery = trpc.session.listSubagents.useQuery(
    { sessionId: selection.parentSessionId, cursor: null, limit: 100 },
    { refetchOnMount: false }
  );
  const query = trpc.session.readSubagentTranscript.useInfiniteQuery(
    {
      sessionId: selection.parentSessionId,
      subagentId: selection.subagent.id,
      cursor: null,
      limit: 10,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }
  );

  const projectedPageCacheRef = useRef(
    new WeakMap<
      object,
      { pageIndex: number; messages: ReturnType<typeof projectAcpTranscriptUpdates> }
    >()
  );
  const messages = useMemo(() => {
    if (!query.data) {
      return [];
    }
    // The validated subagents/read contract guarantees complete-turn page
    // boundaries, so projection state cannot cross between pages. Cache each
    // page independently to avoid rebuilding every already-loaded message index
    // when an older page is appended.
    const projectedPages = query.data.pages.map((page, pageIndex) => {
      const cached = projectedPageCacheRef.current.get(page.updates);
      if (cached?.pageIndex === pageIndex) {
        return cached.messages;
      }
      const projected = projectAcpTranscriptUpdates(page.updates).map((message) => ({
        ...message,
        id: `subagent-page-${pageIndex}-${message.id}`,
      }));
      projectedPageCacheRef.current.set(page.updates, { pageIndex, messages: projected });
      return projected;
    });
    return projectedPages.reverse().flat();
  }, [query.data]);

  useEffect(() => {
    return subscribeToSubagentChanges((detail) => {
      if (
        detail.sessionId === selection.parentSessionId &&
        detail.subagentId === selection.subagent.id
      ) {
        void query.refetch();
        void summaryQuery.refetch();
      }
    });
  }, [query.refetch, selection.parentSessionId, selection.subagent.id, summaryQuery.refetch]);

  const handleLoadOlder = useCallback(() => {
    void query.fetchNextPage();
  }, [query.fetchNextPage]);

  let state: SubagentTranscriptState;
  if (query.error && (!query.data || messages.length === 0)) {
    state = {
      kind: 'unavailable',
      message: query.error.message,
      onRetry: () => {
        void query.refetch();
      },
    };
  } else if (query.isLoading || !query.data) {
    state = { kind: 'loading' };
  } else if (messages.length === 0) {
    state = { kind: 'empty' };
  } else {
    state = {
      kind: 'ready',
      messages,
      hasOlder: Boolean(query.hasNextPage),
      loadingOlder: query.isFetchingNextPage,
      onLoadOlder: handleLoadOlder,
      error: query.error
        ? {
            message: query.error.message,
            onRetry: query.isFetchNextPageError
              ? handleLoadOlder
              : () => {
                  void query.refetch();
                },
          }
        : undefined,
    };
  }

  const refreshedSubagent =
    summaryQuery.data?.supported === true
      ? summaryQuery.data.subagents.find((subagent) => subagent.id === selection.subagent.id)
      : undefined;
  const currentSelection = refreshedSubagent
    ? { ...selection, subagent: refreshedSubagent }
    : selection;

  return (
    <SubagentTranscriptContent
      workspaceId={workspaceId}
      selection={currentSelection}
      onBack={onBack}
      state={state}
    />
  );
}
