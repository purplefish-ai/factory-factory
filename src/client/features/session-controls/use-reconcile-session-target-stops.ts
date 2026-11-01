import { useEffect } from 'react';
import type { SessionStopControl, SessionStopTarget } from '@/shared/acp-protocol/subagents';
import { reconcileSessionTargetStops } from './session-target-stop-state';

export function useReconcileSessionTargetStops(
  sessionId: string | undefined,
  kind: SessionStopTarget['kind'],
  items: readonly { stopControl?: SessionStopControl }[] | undefined
): void {
  useEffect(() => {
    if (sessionId && items) {
      reconcileSessionTargetStops(
        sessionId,
        kind,
        items.flatMap((item) => (item.stopControl ? [item.stopControl.controlId] : []))
      );
    }
  }, [sessionId, kind, items]);
}
