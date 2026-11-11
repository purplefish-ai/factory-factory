import { isFinishedAdversarialReview } from '@/shared/adversarial-review';
import { type SessionStatus as DbSessionStatus, SessionStatus } from '@/shared/core';

interface WorkspaceSessionLimitSession {
  status: DbSessionStatus;
  workflow?: string | null;
  providerSessionId?: string | null;
}

const ACTIVE_SESSION_STATUSES = new Set<DbSessionStatus>([
  SessionStatus.RUNNING,
  SessionStatus.IDLE,
]);

export function getActiveWorkspaceSessionCount(sessions?: WorkspaceSessionLimitSession[]): number {
  return (
    sessions?.filter(
      (session) =>
        ACTIVE_SESSION_STATUSES.has(session.status) && !isFinishedAdversarialReview(session)
    ).length ?? 0
  );
}

export function isWorkspaceSessionLimitReached(
  sessions: WorkspaceSessionLimitSession[] | undefined,
  maxSessions: number | undefined
): boolean {
  return maxSessions !== undefined && getActiveWorkspaceSessionCount(sessions) >= maxSessions;
}

/**
 * Why a new chat can't start right now, or null when it can. The quick actions
 * menu shows it under "Run in new chat".
 */
export function getNewChatUnavailableReason({
  sessions,
  maxSessions,
  isCreatingSession = false,
  isDeletingSession = false,
  hasWorktreePath = true,
}: {
  sessions: WorkspaceSessionLimitSession[] | undefined;
  maxSessions?: number;
  isCreatingSession?: boolean;
  isDeletingSession?: boolean;
  hasWorktreePath?: boolean;
}): string | null {
  if (!hasWorktreePath) {
    return 'New chats can start once the workspace is set up.';
  }
  // New chats inherit the first chat's provider and model, so wait for the list.
  if (sessions === undefined) {
    return 'Loading chats…';
  }
  if (isWorkspaceSessionLimitReached(sessions, maxSessions)) {
    return `This workspace already has the maximum of ${maxSessions} active chats.`;
  }
  if (isCreatingSession) {
    return 'A new chat is starting.';
  }
  if (isDeletingSession) {
    return 'A chat is closing.';
  }
  return null;
}
