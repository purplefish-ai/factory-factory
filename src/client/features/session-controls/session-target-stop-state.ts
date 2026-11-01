import { toast } from 'sonner';
import type { SessionStopTarget } from '@/shared/acp-protocol/subagents';

type PendingStop = {
  sessionId: string;
  target: SessionStopTarget;
  timer: ReturnType<typeof setTimeout>;
};
const pending = new Map<string, PendingStop>();
const listeners = new Set<() => void>();
const keyFor = (sessionId: string, target: SessionStopTarget) =>
  JSON.stringify([sessionId, target.controlId]);

function publish() {
  for (const listener of listeners) {
    listener();
  }
}
function remove(key: string) {
  const entry = pending.get(key);
  if (!entry) {
    return;
  }
  clearTimeout(entry.timer);
  pending.delete(key);
  publish();
}
export function subscribePendingStops(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function isSessionTargetStopPending(sessionId: string, target: SessionStopTarget): boolean {
  return pending.has(keyFor(sessionId, target));
}

/** Reconcile only authoritative current data, never a disconnected or partial cache. */
export function reconcileSessionTargetStops(
  sessionId: string,
  kind: SessionStopTarget['kind'],
  controlIds: readonly string[]
): void {
  const current = new Set(controlIds);
  for (const [key, entry] of pending) {
    if (
      entry.sessionId === sessionId &&
      entry.target.kind === kind &&
      !current.has(entry.target.controlId)
    ) {
      remove(key);
    }
  }
}

/** A pending attempt and its deadline survive disclosure/panel unmounts. */
export async function requestSessionTargetStop(
  sessionId: string,
  target: SessionStopTarget,
  request: () => Promise<unknown>
): Promise<void> {
  const key = keyFor(sessionId, target);
  if (pending.has(key)) {
    return;
  }
  const entry: PendingStop = {
    sessionId,
    target,
    timer: setTimeout(() => {
      if (pending.get(key) !== entry) {
        return;
      }
      remove(key);
      toast.error('Stop confirmation has not arrived. Refresh or try again.');
    }, 15_000),
  };
  pending.set(key, entry);
  publish();
  try {
    await request();
    // Acknowledgment is not completion; live reconciliation owns withdrawal.
  } catch (error) {
    if (pending.get(key) !== entry) {
      return;
    }
    remove(key);
    toast.error(error instanceof Error ? error.message : 'Unable to stop this item. Try again.');
  }
}
