import { describe, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionPermissionService } from './session.permission.service';

describe('SessionPermissionService', () => {
  const sessionDomain = {
    emitDelta: vi.fn(),
    setPendingInteractiveRequest: vi.fn(),
  };

  function createService(): SessionPermissionService {
    vi.clearAllMocks();
    return new SessionPermissionService({
      sessionDomainService: unsafeCoerce(sessionDomain),
    });
  }

  it('resolves pending ACP permissions through the session bridge', async () => {
    const service = createService();
    const bridge = service.createPermissionBridge('session-1');

    const responsePromise = bridge.waitForUserResponse(
      'req-1',
      unsafeCoerce({
        toolCall: {
          toolCallId: 'tool-1',
          title: 'Command',
          rawInput: { command: 'pwd' },
        },
        options: [],
      })
    );

    expect(service.respondToPermission('session-1', 'req-1', 'allow_once')).toBe(true);
    await expect(responsePromise).resolves.toMatchObject({
      outcome: {
        outcome: 'selected',
        optionId: 'allow_once',
      },
    });
  });

  it('cancels pending permissions and clears the bridge for the session', async () => {
    const service = createService();
    const bridge = service.createPermissionBridge('session-1');

    const responsePromise = bridge.waitForUserResponse(
      'req-1',
      unsafeCoerce({
        toolCall: {
          toolCallId: 'tool-1',
          title: 'Command',
          rawInput: { command: 'pwd' },
        },
        options: [],
      })
    );

    service.cancelPendingRequests('session-1');

    await expect(responsePromise).resolves.toMatchObject({
      outcome: {
        outcome: 'cancelled',
      },
    });
    expect(service.respondToPermission('session-1', 'req-1', 'allow_once')).toBe(false);
  });

  it('emits permission_request delta for non-question ACP permission events', () => {
    const service = createService();

    service.handlePermissionRequest(
      'session-1',
      unsafeCoerce({
        type: 'acp_permission_request',
        requestId: 'req-1',
        params: {
          toolCall: {
            toolCallId: 'tool-1',
            title: 'Run shell command',
            rawInput: {
              command: 'pwd',
            },
          },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
          ],
        },
      })
    );

    expect(sessionDomain.emitDelta).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'permission_request',
        requestId: 'req-1',
        toolName: 'Run shell command',
        toolUseId: 'tool-1',
      })
    );
    expect(sessionDomain.setPendingInteractiveRequest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        requestId: 'req-1',
        toolName: 'Run shell command',
        toolUseId: 'tool-1',
      })
    );
  });

  it('emits user_question delta when permission payload includes questions', () => {
    const service = createService();

    service.handlePermissionRequest(
      'session-1',
      unsafeCoerce({
        type: 'acp_permission_request',
        requestId: 'req-2',
        params: {
          toolCall: {
            toolCallId: 'tool-2',
            title: 'AskUserQuestion',
            rawInput: {
              questions: [
                {
                  id: 'q1',
                  question: 'Which path?',
                  header: 'Path',
                  options: [{ label: 'A', description: 'Use A' }],
                },
              ],
            },
          },
          options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
        },
      })
    );

    expect(sessionDomain.emitDelta).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'user_question',
        requestId: 'req-2',
        toolName: 'AskUserQuestion',
      })
    );
  });

  it('extracts plan content for ExitPlanMode permission payloads', () => {
    const service = createService();

    service.handlePermissionRequest(
      'session-1',
      unsafeCoerce({
        type: 'acp_permission_request',
        requestId: 'req-3',
        params: {
          toolCall: {
            toolCallId: 'tool-3',
            title: 'ExitPlanMode',
            rawInput: {
              plan: {
                markdown: '# Plan\n- Step 1',
              },
            },
          },
          options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
        },
      })
    );

    expect(sessionDomain.emitDelta).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'permission_request',
        planContent: '# Plan\n- Step 1',
      })
    );
  });
});
