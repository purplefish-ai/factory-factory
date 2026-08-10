import { useEffect } from 'react';
import { subscribeToSubagentChanges } from '@/client/lib/subagent-events';
import { trpc } from '@/client/lib/trpc';
import type { SubagentSelection } from './types';

export function useLiveSubagentSelection(selection: SubagentSelection): SubagentSelection {
  const query = trpc.session.listSubagents.useQuery(
    { sessionId: selection.parentSessionId, cursor: null, limit: 100 },
    { refetchOnMount: false }
  );

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

  const refreshed = query.data?.supported
    ? query.data.subagents.find((candidate) => candidate.id === selection.subagent.id)
    : undefined;
  return refreshed ? { ...selection, subagent: refreshed } : selection;
}
