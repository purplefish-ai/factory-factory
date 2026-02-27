import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearPendingInteractiveRequestIfMatches: vi.fn(),
}));

vi.mock('@/backend/domains/session/session-domain.service', () => ({
  sessionDomainService: {
    clearPendingInteractiveRequestIfMatches: mocks.clearPendingInteractiveRequestIfMatches,
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createPermissionResponseHandler } from './permission-response.handler';

describe('createPermissionResponseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('responds to pending ACP permission request', () => {
    const ws = { send: vi.fn() };
    const respondToAcpPermission = vi.fn(() => true);
    const handler = createPermissionResponseHandler({
      sessionService: {
        isSessionRunning: vi.fn(),
        sendSessionMessage: vi.fn(),
        respondToAcpPermission,
        setSessionModel: vi.fn(),
        setSessionReasoningEffort: vi.fn(),
        getChatBarCapabilities: vi.fn(),
      },
    });

    void handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: {
        type: 'permission_response',
        requestId: 'req-1',
        optionId: 'allow_once',
        answers: { mode: ['default'] },
      } as never,
    });

    expect(respondToAcpPermission).toHaveBeenCalledWith('session-1', 'req-1', 'allow_once', {
      mode: ['default'],
    });
    expect(ws.send).not.toHaveBeenCalled();
    expect(mocks.clearPendingInteractiveRequestIfMatches).toHaveBeenCalledWith(
      'session-1',
      'req-1'
    );
  });

  it('sends websocket error when no pending request is found', () => {
    const ws = { send: vi.fn() };
    const respondToAcpPermission = vi.fn(() => false);
    const handler = createPermissionResponseHandler({
      sessionService: {
        isSessionRunning: vi.fn(),
        sendSessionMessage: vi.fn(),
        respondToAcpPermission,
        setSessionModel: vi.fn(),
        setSessionReasoningEffort: vi.fn(),
        getChatBarCapabilities: vi.fn(),
      },
    });

    void handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: {
        type: 'permission_response',
        requestId: 'req-2',
        optionId: 'deny_once',
      } as never,
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'error',
        message: 'No pending ACP permission request found for this request ID',
      })
    );
    expect(mocks.clearPendingInteractiveRequestIfMatches).toHaveBeenCalledWith(
      'session-1',
      'req-2'
    );
  });

  it('sends websocket error when permission response throws', () => {
    const ws = { send: vi.fn() };
    const respondToAcpPermission = vi.fn(() => {
      throw new Error('bridge down');
    });
    const handler = createPermissionResponseHandler({
      sessionService: {
        isSessionRunning: vi.fn(),
        sendSessionMessage: vi.fn(),
        respondToAcpPermission,
        setSessionModel: vi.fn(),
        setSessionReasoningEffort: vi.fn(),
        getChatBarCapabilities: vi.fn(),
      },
    });

    void handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: {
        type: 'permission_response',
        requestId: 'req-3',
        optionId: 'allow_once',
      } as never,
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'error',
        message: 'Failed to respond to permission: bridge down',
      })
    );
    expect(mocks.clearPendingInteractiveRequestIfMatches).toHaveBeenCalledWith(
      'session-1',
      'req-3'
    );
  });
});
