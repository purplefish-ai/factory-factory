import { RobotIcon } from '@phosphor-icons/react';
import { useCallback } from 'react';
import { trpc } from '@/client/lib/trpc';
import { SubagentList, type SubagentListState } from './subagent-list';
import type { SubagentListItem, SubagentSelection } from './types';
import { useSubagentInvalidation } from './use-subagent-invalidation';

export interface ProviderSubagentsSectionProps {
  sessionId: string | null;
  enabled: boolean;
  onSelect: (selection: SubagentSelection) => void;
}

export function ProviderSubagentsSection({
  sessionId,
  enabled,
  onSelect,
}: ProviderSubagentsSectionProps) {
  const queryEnabled = Boolean(sessionId && enabled);
  const input = { sessionId: sessionId ?? '', cursor: null, limit: 100 } as const;
  const query = trpc.session.listSubagents.useQuery(input, { enabled: queryEnabled });
  useSubagentInvalidation(sessionId, queryEnabled);

  const handleSelect = useCallback(
    (subagent: SubagentListItem) => {
      if (sessionId) {
        onSelect({ parentSessionId: sessionId, subagent });
      }
    },
    [onSelect, sessionId]
  );

  if (!queryEnabled || query.data?.supported === false) {
    return null;
  }

  let state: SubagentListState;
  if (query.error) {
    state = {
      kind: 'error',
      message: query.error.message,
      onRetry: () => {
        void query.refetch();
      },
    };
  } else if (!query.data || query.isLoading) {
    state = { kind: 'loading' };
  } else {
    state = { kind: 'ready', subagents: query.data.subagents };
  }

  return (
    <section aria-label="Sub-agents">
      <div className="flex items-center gap-1.5 border-b bg-muted/30 px-3 py-2">
        <RobotIcon className="h-3.5 w-3.5 text-muted-foreground" />
        <h2 className="text-xs font-medium">Sub-agents</h2>
        {state.kind === 'ready' && state.subagents.length > 0 && (
          <span className="rounded-full bg-secondary px-1.5 text-[10px] text-secondary-foreground">
            {state.subagents.length}
          </span>
        )}
      </div>
      <SubagentList key={sessionId} state={state} onSelect={handleSelect} />
    </section>
  );
}
