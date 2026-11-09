import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { type ChatServerMessageSchema, parseChatServerMessage } from './chat-server-message-schema';
import { MessageState } from './state-machine';
import type { SessionDeltaEvent, WebSocketMessage } from './websocket';

const runtime = {
  phase: 'idle',
  processState: 'alive',
  activity: 'IDLE',
  updatedAt: '2026-11-09T00:00:00.000Z',
} as const;

function agentMessage(order: number): SessionDeltaEvent {
  return {
    type: 'agent_message',
    messageId: `m-${order}`,
    order,
    data: {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: `tool-${order}`,
          name: 'Edit',
          input: { file_path: `/repo/${order}.ts`, nested: { values: [1, 'two', null] } },
        },
      },
    },
  };
}

describe('ChatServerMessageSchema', () => {
  it('covers every protocol message type', () => {
    expectTypeOf<z.output<typeof ChatServerMessageSchema>['type']>().toEqualTypeOf<
      WebSocketMessage['type']
    >();
  });

  it('round-trips valid frames without changing them', () => {
    const frames: WebSocketMessage[] = [
      agentMessage(3),
      {
        type: 'permission_request',
        requestId: 'req-1',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        planContent: null,
        acpOptions: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      },
      {
        type: 'message_state_changed',
        id: 'q1',
        newState: MessageState.ACCEPTED,
        queuePosition: 0,
        userMessage: {
          text: 'hello',
          timestamp: runtime.updatedAt,
          settings: {
            selectedModel: null,
            reasoningEffort: null,
            thinkingEnabled: false,
            planModeEnabled: false,
          },
        },
      },
      {
        type: 'config_options_update',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            description: null,
            currentValue: 'opus',
            options: [
              { value: 'opus', name: 'Opus', description: null },
              { group: 'Other', options: [{ value: 'sonnet', name: 'Sonnet' }] },
            ],
          },
          { id: 'fast', name: 'Fast', type: 'boolean', currentValue: true },
        ],
      },
      { type: 'session_delta', data: { type: 'task_notification', message: 'Indexing' } },
      {
        type: 'session_snapshot',
        messages: [
          { id: 'u1', source: 'user', text: 'hi', timestamp: runtime.updatedAt, order: 0 },
        ],
        queuedMessages: [],
        sessionRuntime: runtime,
        pendingInteractiveRequest: null,
        loadRequestId: 'load-1',
      },
    ];

    for (const frame of frames) {
      const parsed = parseChatServerMessage(JSON.parse(JSON.stringify(frame)));
      expect(parsed).toEqual({ success: true, message: frame, dropped: [] });
    }
  });

  it.each([
    ['permission request without requestId', { type: 'permission_request', toolName: 'Bash' }],
    ['permission request without toolName', { type: 'permission_request', requestId: 'req-1' }],
    ['user question without requestId', { type: 'user_question', questions: [] }],
    ['user question without questions', { type: 'user_question', requestId: 'req-1' }],
    ['state change without id', { type: 'message_state_changed', newState: 'DISPATCHED' }],
    ['state change without state', { type: 'message_state_changed', id: 'msg-1' }],
    ['unknown message state', { type: 'message_state_changed', id: 'm', newState: 'LOST' }],
    ['error without copy', { type: 'error' }],
    ['task notification without copy', { type: 'task_notification' }],
    ['slash commands without a list', { type: 'slash_commands' }],
    [
      'tool progress without timing',
      { type: 'tool_progress', tool_use_id: 't', tool_name: 'Read' },
    ],
    ['agent message without order', { type: 'agent_message', data: { type: 'result' } }],
    ['agent message with an unknown payload', { type: 'agent_message', order: 1, data: {} }],
    ['runtime without a phase', { type: 'session_runtime_updated', sessionRuntime: {} }],
    ['unknown type', { type: 'not_real' }],
    ['retired type', { type: 'status_update', permissionMode: 'default' }],
  ])('rejects a %s', (_label, frame) => {
    expect(parseChatServerMessage(frame).success).toBe(false);
    expect(parseChatServerMessage({ type: 'session_delta', data: frame }).success).toBe(false);
  });

  it('rejects a snapshot with any invalid transcript row', () => {
    const parsed = parseChatServerMessage({
      type: 'session_snapshot',
      messages: [{ id: 'bad', source: 'robot', timestamp: runtime.updatedAt, order: 0 }],
      queuedMessages: [],
      sessionRuntime: runtime,
    });

    expect(parsed.success).toBe(false);
  });

  it('drops and reports invalid replay events while keeping the valid ones', () => {
    const valid = [{ type: 'session_runtime_snapshot', sessionRuntime: runtime }, agentMessage(1)];
    const parsed = parseChatServerMessage({
      type: 'session_replay_batch',
      loadRequestId: 'load-1',
      replayEvents: [valid[0], { type: 'status_update' }, valid[1], null],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.message).toEqual({
      type: 'session_replay_batch',
      loadRequestId: 'load-1',
      replayEvents: valid,
    });
    expect(parsed.dropped.map((element) => element.path)).toEqual([
      ['replayEvents', 1],
      ['replayEvents', 3],
    ]);
  });

  it('rejects a replay batch whose envelope is invalid', () => {
    expect(
      parseChatServerMessage({ type: 'session_replay_batch', loadRequestId: 42, replayEvents: [] })
        .success
    ).toBe(false);
  });

  it('parses a thousand-message replay as a single frame', () => {
    const replayEvents = Array.from({ length: 1000 }, (_, order) => agentMessage(order));
    const parsed = parseChatServerMessage({ type: 'session_replay_batch', replayEvents });

    expect(parsed.success && parsed.message).toEqual({
      type: 'session_replay_batch',
      replayEvents,
    });
  });
});
