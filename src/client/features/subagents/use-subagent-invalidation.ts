import { useEffect, useRef } from 'react';
import { subscribeToSubagentChanges } from '@/client/lib/subagent-events';
import { trpc } from '@/client/lib/trpc';

function listInput(sessionId: string) {
  return { sessionId, cursor: null, limit: 100 } as const;
}

export function useSubagentInvalidation(sessionId: string | null, enabled: boolean): void {
  const utils = trpc.useUtils();
  const previousStateRef = useRef({ sessionId, enabled });

  useEffect(() => {
    const previous = previousStateRef.current;
    previousStateRef.current = { sessionId, enabled };

    if (sessionId && enabled && previous.sessionId === sessionId && !previous.enabled) {
      void utils.session.listSubagents.invalidate(listInput(sessionId));
    }
  }, [enabled, sessionId, utils.session.listSubagents]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    return subscribeToSubagentChanges((detail) => {
      if (detail.sessionId === sessionId) {
        void utils.session.listSubagents.invalidate(listInput(sessionId));
      }
    });
  }, [sessionId, utils.session.listSubagents]);
}
