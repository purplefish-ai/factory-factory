import { describe, expect, it, vi } from 'vitest';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { applySessionCommandOutcome } from './chat-command-adapter';

describe('applySessionCommandOutcome', () => {
  it.each([undefined, 'config-request'])(
    'delivers correlated requester errors without publishing configuration',
    (requestId) => {
      const ws = { send: vi.fn() };
      applySessionCommandOutcome(ws, {
        replies: [
          {
            type: 'error',
            error: {
              kind: 'set_config_option_failed',
              cause: { data: { reason: 'invalid preset' } },
            },
            ...(requestId !== undefined ? { requestId } : {}),
          },
        ],
      });
      expect(ws.send).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          type: 'error',
          ...(requestId !== undefined ? { requestId } : {}),
          message: 'Failed to set config option: {"reason":"invalid preset"}',
        })
      );
    }
  );

  it('sends capabilities only to the requesting viewer and tolerates legacy void outcomes', () => {
    const ws = { send: vi.fn() };
    applySessionCommandOutcome(ws, {
      replies: [{ type: 'chat_capabilities', capabilities: EMPTY_CHAT_BAR_CAPABILITIES }],
    });
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'chat_capabilities', capabilities: EMPTY_CHAT_BAR_CAPABILITIES })
    );
    applySessionCommandOutcome(ws, undefined);
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('formats circular configuration errors with the existing string fallback', () => {
    const cause: { self?: unknown } = {};
    cause.self = cause;
    const ws = { send: vi.fn() };
    applySessionCommandOutcome(ws, {
      replies: [{ type: 'error', error: { kind: 'set_config_option_failed', cause } }],
    });
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Failed to set config option: [object Object]' })
    );
  });

  it('retains the model-delivery error fallback at the transport boundary', () => {
    const ws = {
      send: vi.fn().mockImplementationOnce(() => {
        throw new Error('send failed');
      }),
    };
    applySessionCommandOutcome(ws, {
      replies: [{ type: 'chat_capabilities', capabilities: EMPTY_CHAT_BAR_CAPABILITIES }],
    });
    expect(ws.send).toHaveBeenLastCalledWith(
      JSON.stringify({ type: 'error', message: 'Failed to set model: send failed' })
    );
  });

  it.each([
    [{ kind: 'session_not_found' }, 'Session not found'],
    [
      { kind: 'workspace_archived' },
      'Workspace is archived or archiving and cannot start sessions.',
    ],
    [{ kind: 'no_active_session' }, 'No active session. Use queue_message to queue messages.'],
    [
      { kind: 'background_monitoring_required' },
      'Disable PR updates to cancel background monitoring',
    ],
    [{ kind: 'message_not_queued' }, 'Message not found in queue'],
    [{ kind: 'queue_input_invalid', reason: 'Missing message id' }, 'Missing message id'],
    [{ kind: 'start_failed', cause: new Error('boom') }, 'Failed to start agent: boom'],
    [{ kind: 'start_failed', cause: 42 }, 'Failed to start agent: 42'],
    [{ kind: 'no_session' }, 'No session selected. Please create or select a session first.'],
    [
      { kind: 'permission_not_pending' },
      'No pending ACP permission request found for this request ID',
    ],
    [{ kind: 'set_model_failed', cause: new Error('boom') }, 'Failed to set model: boom'],
    [{ kind: 'set_thinking_budget_failed', cause: 'bad' }, 'Failed to set thinking budget: bad'],
    [{ kind: 'permission_response_failed', cause: 42 }, 'Failed to respond to permission: 42'],
    [
      { kind: 'set_config_option_failed', cause: { message: 'invalid option' } },
      'Failed to set config option: invalid option',
    ],
    [{ kind: 'set_config_option_failed', cause: 42 }, 'Failed to set config option: 42'],
    [
      { kind: 'set_config_option_failed', cause: { code: 403 } },
      'Failed to set config option: ACP error (403)',
    ],
  ] as const)('preserves error copy for %o', (error, message) => {
    const ws = { send: vi.fn() };
    applySessionCommandOutcome(ws, { replies: [{ type: 'error', error }] });
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', message }));
  });
});
