import { useEffect } from 'react';
import type { SessionStopControl, SessionStopTarget } from '@/shared/acp-protocol/subagents';
import { reconcileSessionTargetStops } from './session-target-stop-state';

export function useReconcileSessionTargetStops(
  sessionId: string | undefined,
  kind: SessionStopTarget['kind'],
  items: readonly { stopControl?: SessionStopControl }[]
): void {
  useEffect(() => {
    if (sessionId) {
      reconcileSessionTargetStops(
        sessionId,
        kind,
        items.flatMap((item) => (item.stopControl ? [item.stopControl.controlId] : []))
      );
    }
  }, [sessionId, kind, items]);
}
