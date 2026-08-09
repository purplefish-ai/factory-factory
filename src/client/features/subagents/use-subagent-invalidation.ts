import { useEffect, useReducer, useRef } from 'react';
import { subscribeToSubagentChanges } from '@/client/lib/subagent-events';
import { trpc } from '@/client/lib/trpc';

function listInput(sessionId: string) {
  return { sessionId, cursor: null, limit: 100 } as const;
}

export function useSubagentInvalidation(sessionId: string | null, enabled: boolean): boolean {
  const utils = trpc.useUtils();
  const invalidateList = utils.session.listSubagents.invalidate;
  const previousStateRef = useRef({ sessionId, enabled });
  const [, finishReconnect] = useReducer((version: number) => version + 1, 0);
  const previous = previousStateRef.current;
  const reconnecting = Boolean(
    sessionId && enabled && previous.sessionId === sessionId && !previous.enabled
  );

  useEffect(() => {
    const previous = previousStateRef.current;
    if (!(sessionId && enabled && previous.sessionId === sessionId && !previous.enabled)) {
      previousStateRef.current = { sessionId, enabled };
      return;
    }

    let active = true;
    const complete = () => {
      if (!active) {
        return;
      }
      previousStateRef.current = { sessionId, enabled: true };
      finishReconnect();
    };
    void invalidateList(listInput(sessionId)).then(complete, complete);
    return () => {
      active = false;
    };
  }, [enabled, invalidateList, sessionId]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    return subscribeToSubagentChanges((detail) => {
      if (detail.sessionId === sessionId) {
        void invalidateList(listInput(sessionId));
      }
    });
  }, [invalidateList, sessionId]);

  return enabled && !reconnecting;
}
