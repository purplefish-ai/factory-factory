// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { subscribeToSubagentChanges } from '@/client/lib/subagent-events';
import type { AgentMessage, WebSocketMessage } from '@/lib/chat-protocol';
import { parseChatServerMessage } from '@/shared/acp-protocol/protocol/chat-server-message-schema';
import type { ChatAction } from './reducer';
import { createToolInputAccumulatorState, handleToolInputStreaming } from './streaming-utils';
import { useChatTransport } from './use-chat-transport';

function TransportHarness({
  dispatch,
  result,
}: {
  dispatch: (action: ChatAction) => void;
  result: { handleMessage?: (message: WebSocketMessage) => void };
}) {
  result.handleMessage = useChatTransport({
    dispatch,
    stateRef: { current: {} } as never,
    toolInputAccumulatorRef: { current: createToolInputAccumulatorState() },
  }).handleMessage;
  return null;
}

function renderTransport(dispatch: (action: ChatAction) => void) {
  const container = document.createElement('div');
  const root = createRoot(container);
  const result: { handleMessage?: (message: WebSocketMessage) => void } = {};

  flushSync(() => root.render(createElement(TransportHarness, { dispatch, result })));
  if (!result.handleMessage) {
    throw new Error('Expected the hook harness to expose handleMessage');
  }
  return {
    handleMessage: result.handleMessage,
    cleanup: () => flushSync(() => root.unmount()),
  };
}

describe('sub-agent invalidation transport', () => {
  it('dispatches one typed browser event and no chat reducer action', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToSubagentChanges(listener);
    const dispatch = vi.fn<(action: ChatAction) => void>();
    const transport = renderTransport(dispatch);

    transport.handleMessage({
      type: 'session_delta',
      data: {
        type: 'subagents_changed',
        sessionId: 'db-session-1',
        subagentId: 'child-1',
        change: 'updated',
      },
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      sessionId: 'db-session-1',
      subagentId: 'child-1',
      change: 'updated',
    });
    expect(dispatch).not.toHaveBeenCalled();

    unsubscribe();
    transport.cleanup();
  });

  it('rejects a malformed wrapped invalidation before it reaches the transport', () => {
    expect(
      parseChatServerMessage({
        type: 'session_delta',
        data: {
          type: 'subagents_changed',
          sessionId: 'db-session-1',
          subagentId: 'child-1',
          change: 'deleted',
        },
      }).success
    ).toBe(false);
  });
});

describe('handleToolInputStreaming', () => {
  it('accumulates input_json_delta and returns TOOL_INPUT_UPDATE when JSON is complete', () => {
    const toolInputAccumulatorRef = { current: createToolInputAccumulatorState() };

    const startMsg: AgentMessage = {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'search', input: {} },
      },
    };

    expect(handleToolInputStreaming(startMsg, toolInputAccumulatorRef)).toBeNull();
    expect(toolInputAccumulatorRef.current.toolUseIdByIndex.get(0)).toBe('tool-1');
    expect(toolInputAccumulatorRef.current.inputJsonByToolUseId.get('tool-1')).toBe('');

    const partialMsg: AgentMessage = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"hi"' },
      },
    };

    expect(handleToolInputStreaming(partialMsg, toolInputAccumulatorRef)).toBeNull();
    expect(toolInputAccumulatorRef.current.inputJsonByToolUseId.get('tool-1')).toBe(
      '{"query":"hi"'
    );

    const finalMsg: AgentMessage = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '}' },
      },
    };

    expect(handleToolInputStreaming(finalMsg, toolInputAccumulatorRef)).toEqual({
      type: 'TOOL_INPUT_UPDATE',
      payload: { toolUseId: 'tool-1', input: { query: 'hi' } },
    });
  });

  it('cleans up accumulator entries on content_block_stop', () => {
    const toolInputAccumulatorRef = { current: createToolInputAccumulatorState() };
    const startMsg: AgentMessage = {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 3,
        content_block: { type: 'tool_use', id: 'tool-3', name: 'search', input: {} },
      },
    };
    handleToolInputStreaming(startMsg, toolInputAccumulatorRef);

    const stopMsg: AgentMessage = {
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 3 },
    };
    handleToolInputStreaming(stopMsg, toolInputAccumulatorRef);

    expect(toolInputAccumulatorRef.current.toolUseIdByIndex.has(3)).toBe(false);
    expect(toolInputAccumulatorRef.current.inputJsonByToolUseId.has('tool-3')).toBe(false);
  });

  it('returns null when message is not a stream_event', () => {
    const toolInputAccumulatorRef = { current: createToolInputAccumulatorState() };
    const nonStream: AgentMessage = {
      type: 'assistant',
      message: { role: 'assistant', content: 'ok' },
    };

    expect(handleToolInputStreaming(nonStream, toolInputAccumulatorRef)).toBeNull();
    expect(toolInputAccumulatorRef.current.toolUseIdByIndex.size).toBe(0);
    expect(toolInputAccumulatorRef.current.inputJsonByToolUseId.size).toBe(0);
  });
});

describe('parseChatServerMessage', () => {
  const accepts = (data: unknown) => parseChatServerMessage(data).success;

  it('rejects unknown websocket message types', () => {
    expect(accepts({ type: 'not_real' })).toBe(false);
  });

  it('rejects session_delta payloads without nested websocket event', () => {
    expect(accepts({ type: 'session_delta', data: { foo: 'bar' } })).toBe(false);
    expect(accepts({ type: 'session_delta', data: null })).toBe(false);
  });

  it('accepts valid session_delta payloads', () => {
    expect(
      accepts({
        type: 'session_delta',
        data: { type: 'task_notification', message: 'Indexing' },
      })
    ).toBe(true);
  });

  it.each([
    'system_init',
    'hook_started',
    'hook_response',
    'tool_use_summary',
    'status_update',
    'agent_metadata',
    'user_message_uuid',
    'message_used_as_response',
    'sessions',
  ])('rejects the retired %s message type', (type) => {
    expect(accepts({ type })).toBe(false);
    expect(accepts({ type: 'session_delta', data: { type } })).toBe(false);
  });

  it('accepts direct and nested assistant text delta payloads', () => {
    const delta = {
      type: 'assistant_text_delta',
      messageId: 'session-1-7',
      order: 7,
      offset: 5,
      text: ' world',
    };

    expect(accepts(delta)).toBe(true);
    expect(accepts({ type: 'session_delta', data: delta })).toBe(true);
  });

  it('rejects malformed assistant text delta payloads', () => {
    expect(
      accepts({
        type: 'assistant_text_delta',
        messageId: '',
        order: 7,
        offset: 5,
        text: ' world',
      })
    ).toBe(false);
    expect(
      accepts({
        type: 'assistant_text_delta',
        messageId: 'session-1-7',
        order: -1,
        offset: 5,
        text: ' world',
      })
    ).toBe(false);
    expect(
      accepts({
        type: 'assistant_text_delta',
        messageId: 'session-1-7',
        order: 7,
        offset: 1.5,
        text: ' world',
      })
    ).toBe(false);
    expect(
      accepts({
        type: 'assistant_text_delta',
        messageId: 'session-1-7',
        order: 7,
        offset: 5,
      })
    ).toBe(false);
  });

  it('rejects non-delta nested payload types inside session_delta', () => {
    expect(accepts({ type: 'session_delta', data: { type: 'session_snapshot' } })).toBe(false);
    expect(accepts({ type: 'session_delta', data: { type: 'session_replay_batch' } })).toBe(false);
    expect(accepts({ type: 'session_delta', data: { type: 'session_delta' } })).toBe(false);
  });

  it('rejects agent_message without a nested Claude payload', () => {
    expect(accepts({ type: 'agent_message' })).toBe(false);
    expect(accepts({ type: 'agent_message', data: null })).toBe(false);
    expect(accepts({ type: 'agent_message', data: { type: 'not_real' } })).toBe(false);
  });
});
