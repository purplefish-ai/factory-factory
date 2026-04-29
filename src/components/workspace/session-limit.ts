import { type SessionStatus as DbSessionStatus, SessionStatus } from '@/shared/core';

interface WorkspaceSessionLimitSession {
  status: DbSessionStatus;
}

const ACTIVE_SESSION_STATUSES = new Set<DbSessionStatus>([
  SessionStatus.RUNNING,
  SessionStatus.IDLE,
]);

export function getActiveWorkspaceSessionCount(sessions?: WorkspaceSessionLimitSession[]): number {
  return sessions?.filter((session) => ACTIVE_SESSION_STATUSES.has(session.status)).length ?? 0;
}

export function isWorkspaceSessionLimitReached(
  sessions: WorkspaceSessionLimitSession[] | undefined,
  maxSessions: number | undefined
): boolean {
  return maxSessions !== undefined && getActiveWorkspaceSessionCount(sessions) >= maxSessions;
}
