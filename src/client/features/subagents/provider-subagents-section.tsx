import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { useCallback, useEffect, useMemo } from 'react';
import { trpc } from '@/client/lib/trpc';
import { SubagentList, type SubagentListState } from './subagent-list';
import { getNextSubagentPageParam, getSubagentListError } from './subagent-pagination';
import { isActiveSubagent } from './subagent-status';
import type { SubagentListItem, SubagentSelection } from './types';
import { useSubagentInvalidation } from './use-subagent-invalidation';

export interface ProviderSubagentsSectionProps {
  sessionId: string | null;
  parentSessionName: string | null;
  enabled: boolean;
  onSelect: (selection: SubagentSelection) => void;
}

export function ProviderSubagentsSection({
  sessionId,
  parentSessionName,
  enabled,
  onSelect,
}: ProviderSubagentsSectionProps) {
  const requestedQuery = Boolean(sessionId && enabled);
  const queryEnabled = useSubagentInvalidation(sessionId, requestedQuery);
  const input = { sessionId: sessionId ?? '', cursor: null, limit: 100 } as const;
  const query = trpc.session.listSubagents.useInfiniteQuery(input, {
    enabled: queryEnabled,
    refetchOnMount: 'always',
    getNextPageParam: getNextSubagentPageParam,
  });
  const { fetchNextPage, hasNextPage, isFetching } = query;
  const error = getSubagentListError(query);
  const pageCount = query.data?.pages.length;
  useEffect(() => {
    if (queryEnabled && pageCount && hasNextPage && !isFetching && !error) {
      void fetchNextPage();
    }
  }, [queryEnabled, pageCount, hasNextPage, isFetching, error, fetchNextPage]);
  const supportedPages = useMemo(
    () => query.data?.pages.filter((page) => page.supported) ?? [],
    [query.data?.pages]
  );
  const subagents = useMemo(() => {
    const byId = new Map<string, SubagentListItem>();
    for (const page of supportedPages) {
      for (const subagent of page.subagents) {
        if (!byId.has(subagent.id)) {
          byId.set(subagent.id, subagent);
        }
      }
    }
    return [...byId.values()];
  }, [supportedPages]);

  const handleSelect = useCallback(
    (subagent: SubagentListItem) => {
      if (sessionId) {
        onSelect({
          parentSessionId: sessionId,
          parentSessionName: parentSessionName?.trim() || 'Untitled session',
          subagent,
        });
      }
    },
    [onSelect, parentSessionName, sessionId]
  );

  if (!queryEnabled || query.data?.pages.some((page) => page.supported === false)) {
    return null;
  }

  let state: SubagentListState;
  if (error && !query.data) {
    state = {
      kind: 'error',
      message: error.message,
      onRetry: () => {
        void query.refetch();
      },
    };
  } else if (!query.data || query.isLoading) {
    state = { kind: 'loading' };
  } else {
    state = {
      kind: 'ready',
      subagents,
      hasMore: Boolean(query.hasNextPage),
      loadingMore: query.isFetchingNextPage,
      error: error
        ? {
            message: error.message,
            onRetry: query.isFetchNextPageError
              ? () => {
                  void query.fetchNextPage();
                }
              : () => {
                  void query.refetch();
                },
          }
        : undefined,
    };
  }

  return (
    <section aria-label="Sub-agents">
      <div className="flex items-center gap-1.5 border-b bg-muted/30 px-3 py-2">
        <RobotIcon className="h-3.5 w-3.5 text-muted-foreground" />
        <h2 className="text-xs font-medium">Sub-agents</h2>
        {state.kind === 'ready' && !state.hasMore && !state.error && state.subagents.length > 0 && (
          <span
            role="status"
            aria-label="Active sub-agents"
            className="rounded-full bg-secondary px-1.5 text-[10px] text-secondary-foreground"
          >
            {state.subagents.filter(isActiveSubagent).length}
          </span>
        )}
      </div>
      <SubagentList key={sessionId} state={state} onSelect={handleSelect} />
    </section>
  );
}
