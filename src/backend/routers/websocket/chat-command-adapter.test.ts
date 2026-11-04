import { describe, expect, it, vi } from 'vitest';
import { MessageState } from '@/shared/acp-protocol';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { applySessionCommandOutcome } from './chat-command-adapter';

describe('applySessionCommandOutcome', () => {
  it.each([
    { malformed: null },
    { malformed: 17 },
    { malformed: { type: 'image' } },
    { malformed: { type: 'image', source: null } },
    { malformed: { type: 'image', source: { type: 'base64', data: 'aGVsbG8=' } } },
    {
      malformed: {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: '%invalid%' },
      },
    },
    { malformed: { type: 'future_block', value: 'unknown' } },
    { malformed: { type: 'thinking', thinking: 'unsupported human input' } },
    { malformed: { type: 'tool_use', id: 'tool', name: 'unsupported', input: {} } },
    { malformed: { type: 'tool_result', tool_use_id: 'tool', content: 'unsupported' } },
    {
      malformed: {
        type: 'tool_result',
        tool_use_id: 'tool',
        content: [{ type: 'image', source: null }],
      },
    },
  ])('recovers valid text without throwing on malformed input: %j', ({ malformed }) => {
    const ws = { send: vi.fn() };
    expect(() =>
      applySessionCommandOutcome(ws, {
        replies: [
          {
            type: 'error',
            error: {
              kind: 'user_input_failed',
              sessionId: 'session-1',
              content: [{ type: 'text', text: 'recover this' }, malformed],
              cause: new Error('invalid input'),
            },
          },
        ],
      })
    ).not.toThrow();
    expect(JSON.parse(ws.send.mock.calls[0]![0])).toMatchObject({
      type: 'message_state_changed',
      newState: MessageState.REJECTED,
      userMessage: { text: 'recover this', sessionId: 'session-1' },
    });
    expect(JSON.parse(ws.send.mock.calls[0]![0]).userMessage.attachments).toBeUndefined();
  });

  it.each([
    { content: 'original draft' },
    {
      content: [
        { type: 'text' as const, text: 'original draft' },
        {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: 'image/png', data: 'aGVsbG8=' },
        },
      ],
    },
  ])('restores failed direct input through the existing rejection event: %j', ({ content }) => {
    const ws = { send: vi.fn() };
    applySessionCommandOutcome(ws, {
      replies: [
        {
          type: 'error',
          error: {
            kind: 'user_input_failed',
            sessionId: 'session-1',
            content,
            cause: new Error('database unavailable'),
          },
        },
      ],
    });
    expect(ws.send).toHaveBeenCalledExactlyOnceWith(expect.any(String));
    expect(JSON.parse(ws.send.mock.calls[0]![0])).toMatchObject({
      type: 'message_state_changed',
      id: expect.any(String),
      newState: MessageState.REJECTED,
      errorMessage: 'Could not send message. Try again.',
      userMessage: {
        text: 'original draft',
        sessionId: 'session-1',
        timestamp: expect.any(String),
      },
    });
    if (Array.isArray(content)) {
      expect(JSON.parse(ws.send.mock.calls[0]![0]).userMessage.attachments).toEqual([
        {
          id: expect.any(String),
          name: 'image.png',
          type: 'image/png',
          contentType: 'image',
          size: 5,
          data: 'aGVsbG8=',
        },
      ]);
    }
  });

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
