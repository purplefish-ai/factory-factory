import { describe, expect, it, vi } from 'vitest';
import { SessionPermissionService } from '@/backend/services/session/service/lifecycle/session.permission.service';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
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

  it('keeps a replacement pending request after resolving and repeating an older response', async () => {
    const domain = new SessionDomainService();
    const service = new SessionPermissionService({ sessionDomainService: domain });
    const bridge = service.createPermissionBridge('session-1');
    const handler = createPermissionResponseHandler({ sessionPermissionService: service });
    const params = {
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-1', title: 'Command' },
      options: [{ optionId: 'allow_once', kind: 'allow_once' as const, name: 'Allow once' }],
    };
    function request(requestId: string) {
      const response = bridge.waitForUserResponse(requestId, params);
      service.handlePermissionRequest('session-1', {
        type: 'acp_permission_request',
        requestId,
        params,
      });
      return response;
    }
    const older = request('old-request');
    const replacement = request('newer-request');
    const pending = domain.getPendingInteractiveRequest('session-1');
    expect(pending?.requestId).toBe('newer-request');

    expect(
      await handler(context, {
        type: 'permission_response',
        requestId: 'old-request',
        optionId: 'allow_once',
      })
    ).toEqual({ replies: [] });
    expect(domain.getPendingInteractiveRequest('session-1')).toBe(pending);
    expect(
      await handler(context, {
        type: 'permission_response',
        requestId: 'old-request',
        optionId: 'allow_once',
      })
    ).toEqual({
      replies: [{ type: 'error', error: { kind: 'permission_not_pending' } }],
    });
    expect(domain.getPendingInteractiveRequest('session-1')).toBe(pending);
    expect(
      await handler(context, {
        type: 'permission_response',
        requestId: 'newer-request',
        optionId: 'invalid-option',
      })
    ).toEqual({
      replies: [{ type: 'error', error: { kind: 'permission_not_pending' } }],
    });
    expect(domain.getPendingInteractiveRequest('session-1')).toBe(pending);
    expect(bridge.hasPending('newer-request')).toBe(true);

    expect(
      await handler(context, {
        type: 'permission_response',
        requestId: 'newer-request',
        optionId: 'allow_once',
      })
    ).toEqual({ replies: [] });
    expect(domain.getPendingInteractiveRequest('session-1')).toBeNull();
    await expect(older).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
    await expect(replacement).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
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
