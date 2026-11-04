import { describe, expect, it } from 'vitest';
import { SessionStatus } from '@/shared/core';
import {
  getActiveWorkspaceSessionCount,
  getNewChatUnavailableReason,
  isWorkspaceSessionLimitReached,
} from './session-limit';

function session(status: SessionStatus) {
  return { status };
}

describe('workspace session limit', () => {
  it('counts only running and idle sessions as active', () => {
    const sessions = [
      session(SessionStatus.RUNNING),
      session(SessionStatus.IDLE),
      session(SessionStatus.COMPLETED),
      session(SessionStatus.FAILED),
      session(SessionStatus.PAUSED),
    ];

    expect(getActiveWorkspaceSessionCount(sessions)).toBe(2);
  });

  it('does not block new sessions when only completed or failed sessions exceed the limit', () => {
    const sessions = [
      session(SessionStatus.COMPLETED),
      session(SessionStatus.FAILED),
      session(SessionStatus.COMPLETED),
    ];

    expect(isWorkspaceSessionLimitReached(sessions, 2)).toBe(false);
  });

  it('blocks new sessions once active sessions reach the limit', () => {
    const sessions = [
      session(SessionStatus.RUNNING),
      session(SessionStatus.IDLE),
      session(SessionStatus.COMPLETED),
    ];

    expect(isWorkspaceSessionLimitReached(sessions, 2)).toBe(true);
  });

  it('does not apply a limit when max sessions is undefined', () => {
    const sessions = [session(SessionStatus.RUNNING)];

    expect(isWorkspaceSessionLimitReached(sessions, undefined)).toBe(false);
  });
});

describe('new chat availability', () => {
  const active = [session(SessionStatus.RUNNING), session(SessionStatus.IDLE)];

  it('allows a new chat when nothing blocks it', () => {
    expect(getNewChatUnavailableReason({ sessions: active, maxSessions: 3 })).toBeNull();
  });

  it.each([
    [{ sessions: active, hasWorktreePath: false }, 'once the workspace is set up'],
    [{ sessions: undefined }, 'Loading chats'],
    [{ sessions: active, maxSessions: 2 }, 'maximum of 2 active chats'],
    [{ sessions: active, isCreatingSession: true }, 'A new chat is starting'],
    [{ sessions: active, isDeletingSession: true }, 'A chat is closing'],
  ])('explains why a new chat is blocked: %o', (input, reason) => {
    expect(getNewChatUnavailableReason(input)).toContain(reason);
  });
});
