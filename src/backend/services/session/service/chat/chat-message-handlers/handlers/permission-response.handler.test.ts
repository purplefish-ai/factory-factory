import { describe, expect, it, vi } from 'vitest';
import { createPermissionResponseHandler } from './permission-response.handler';

const context = { sessionId: 'session-1', workingDir: '/tmp/work' };

describe('createPermissionResponseHandler', () => {
  it('delegates permission completion to the injected service without a socket', async () => {
    const respondToPermission = vi.fn(() => true);
    const handler = createPermissionResponseHandler({
      sessionPermissionService: { respondToPermission },
    });
    expect(
      await handler(context, {
        type: 'permission_response',
        requestId: 'req-1',
        optionId: 'allow_once',
        answers: { mode: ['default'] },
      })
    ).toEqual({ replies: [] });
    expect(respondToPermission).toHaveBeenCalledWith('session-1', 'req-1', 'allow_once', {
      mode: ['default'],
    });
    expect(respondToPermission).toHaveBeenCalledTimes(1);
  });

  it('returns a requester-only error when no pending request is found', async () => {
    const respondToPermission = vi.fn(() => false);
    const handler = createPermissionResponseHandler({
      sessionPermissionService: { respondToPermission },
    });
    expect(
      await handler(context, {
        type: 'permission_response',
        requestId: 'req-2',
        optionId: 'deny_once',
      })
    ).toEqual({ replies: [{ type: 'error', error: { kind: 'permission_not_pending' } }] });
    expect(respondToPermission).toHaveBeenCalledWith('session-1', 'req-2', 'deny_once', undefined);
  });

  it('leaves a newer pending request alone when a stale response is rejected', async () => {
    const pending = { id: 'newer-request' };
    const respondToPermission = vi.fn((_sessionId, requestId) => requestId === pending.id);
    const handler = createPermissionResponseHandler({
      sessionPermissionService: { respondToPermission },
    });
    const outcome = await handler(context, {
      type: 'permission_response',
      requestId: 'old-request',
      optionId: 'invalid-option',
    });
    expect(outcome).toEqual({
      replies: [{ type: 'error', error: { kind: 'permission_not_pending' } }],
    });
    expect(pending.id).toBe('newer-request');
  });

  it('returns the original permission response failure', async () => {
    const cause = new Error('bridge down');
    const respondToPermission = vi.fn(() => {
      throw cause;
    });
    const handler = createPermissionResponseHandler({
      sessionPermissionService: { respondToPermission },
    });
    expect(
      await handler(context, {
        type: 'permission_response',
        requestId: 'req-3',
        optionId: 'allow_once',
      })
    ).toEqual({
      replies: [{ type: 'error', error: { kind: 'permission_response_failed', cause } }],
    });
  });
});
