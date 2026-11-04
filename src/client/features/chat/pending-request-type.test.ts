import { describe, expect, it } from 'vitest';
import { getChatPendingRequestType } from './pending-request-type';
import { createActionFromWebSocketMessage } from './reducer';

function permission(toolName: string, toolInput: Record<string, unknown> = {}) {
  return {
    type: 'permission' as const,
    request: { requestId: 'r', toolName, toolInput, timestamp: '2026-11-04T00:00:00Z' },
  };
}

describe('getChatPendingRequestType', () => {
  it('retains provider identity from a live permission event', () => {
    const action = createActionFromWebSocketMessage({
      type: 'permission_request',
      requestId: 'r',
      toolName: 'ExitPlanMode',
      rawToolName: 'mcp__server__plan',
      toolInput: { type: 'ExitPlanMode' },
    });
    expect(action?.type).toBe('WS_PERMISSION_REQUEST');
    if (action?.type !== 'WS_PERMISSION_REQUEST') {
      throw new Error('Expected permission request');
    }
    expect(getChatPendingRequestType({ type: 'permission', request: action.payload })).toBe(
      'permission_request'
    );
  });

  it('returns null when nothing is pending', () => {
    expect(getChatPendingRequestType({ type: 'none' })).toBeNull();
  });

  it.each([
    { toolName: 'mcp__server__plan' },
    { toolName: 'ExitPlanMode', rawToolName: 'mcp__server__plan' },
  ])('preserves MCP permission identity: %j', (identity) => {
    const request = permission(identity.toolName, { type: 'ExitPlanMode' });
    expect(
      getChatPendingRequestType({ ...request, request: { ...request.request, ...identity } })
    ).toBe('permission_request');
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
    expect(
      getChatPendingRequestType({
        type: 'question',
        request: {
          requestId: 'plan',
          toolName: 'ExitPlanMode',
          questions: [],
          timestamp: '2026-11-04T00:00:00Z',
        },
      })
    ).toBe('plan_approval');
    expect(getChatPendingRequestType(permission('ExitPlanMode'))).toBe('plan_approval');
    expect(getChatPendingRequestType(permission('Ready?', { type: 'ExitPlanMode' }))).toBe(
      'plan_approval'
    );
    expect(getChatPendingRequestType(permission('Bash', { command: 'ls' }))).toBe(
      'permission_request'
    );
  });
});
