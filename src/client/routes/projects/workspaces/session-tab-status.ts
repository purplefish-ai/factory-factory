import type { ProcessStatus, SessionStatus } from '@/components/chat/reducer';

interface SessionWithWorkingState {
  id: string;
  isWorking?: boolean;
}

interface DeriveRunningSessionIdsOptions {
  sessions?: SessionWithWorkingState[];
  selectedDbSessionId: string | null;
  sessionStatus: SessionStatus;
  processStatus: ProcessStatus;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}

/**
 * Maintains workspace-level running session state using:
 * 1) Polling data for all sessions (authoritative when available)
 * 2) Live WebSocket state for the currently selected session (immediate)
 */
export function deriveRunningSessionIds(
  previous: ReadonlySet<string>,
  options: DeriveRunningSessionIdsOptions
): ReadonlySet<string> {
  const { sessions, selectedDbSessionId, sessionStatus, processStatus } = options;
  const next = new Set((sessions ?? []).filter((session) => session.isWorking).map((s) => s.id));

  if (
    selectedDbSessionId &&
    sessionStatus.phase === 'running' &&
    processStatus.state !== 'stopped'
  ) {
    next.add(selectedDbSessionId);
  }

  return setsEqual(previous, next) ? previous : next;
}
