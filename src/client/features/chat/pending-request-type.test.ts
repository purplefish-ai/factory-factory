import { describe, expect, it } from 'vitest';
import { getChatPendingRequestType } from './pending-request-type';

function permission(toolName: string, toolInput: Record<string, unknown> = {}) {
  return {
    type: 'permission' as const,
    request: { requestId: 'r', toolName, toolInput, timestamp: '2026-11-04T00:00:00Z' },
  };
}

describe('getChatPendingRequestType', () => {
  it('returns null when nothing is pending', () => {
    expect(getChatPendingRequestType({ type: 'none' })).toBeNull();
  });

  it('classifies questions, plan approvals and other permissions', () => {
    expect(
      getChatPendingRequestType({
        type: 'question',
        request: {
          requestId: 'q',
          toolName: 'AskUserQuestion',
          questions: [],
          timestamp: '2026-11-04T00:00:00Z',
        },
      })
    ).toBe('user_question');
    expect(getChatPendingRequestType(permission('ExitPlanMode'))).toBe('plan_approval');
    expect(getChatPendingRequestType(permission('Ready?', { type: 'ExitPlanMode' }))).toBe(
      'plan_approval'
    );
    expect(getChatPendingRequestType(permission('Bash', { command: 'ls' }))).toBe(
      'permission_request'
    );
  });
});
