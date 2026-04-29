import { describe, expect, it } from 'vitest';
import { SessionStatus } from '@/shared/core';
import { getActiveWorkspaceSessionCount, isWorkspaceSessionLimitReached } from './session-limit';

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
