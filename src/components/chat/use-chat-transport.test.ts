import { describe, expect, it } from 'vitest';
import { type ClaudeMessage, isWebSocketMessage } from '@/lib/claude-types';
import { handleThinkingStreaming, handleToolInputStreaming } from './streaming-utils';

describe('handleToolInputStreaming', () => {
  it('accumulates input_json_delta and returns TOOL_INPUT_UPDATE when JSON is complete', () => {
    const toolInputAccumulatorRef = { current: new Map<string, string>() };

    const startMsg: ClaudeMessage = {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'search', input: {} },
      },
    };

    expect(handleToolInputStreaming(startMsg, toolInputAccumulatorRef)).toBeNull();
    expect(toolInputAccumulatorRef.current.get('tool-1')).toBe('');

    const partialMsg: ClaudeMessage = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"hi"' },
      },
    };

    expect(handleToolInputStreaming(partialMsg, toolInputAccumulatorRef)).toBeNull();
    expect(toolInputAccumulatorRef.current.get('tool-1')).toBe('{"query":"hi"');

    const finalMsg: ClaudeMessage = {
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

  it('returns null when message is not a stream_event', () => {
    const toolInputAccumulatorRef = { current: new Map<string, string>() };
    const nonStream: ClaudeMessage = {
      type: 'assistant',
      message: { role: 'assistant', content: 'ok' },
    };

    expect(handleToolInputStreaming(nonStream, toolInputAccumulatorRef)).toBeNull();
    expect(toolInputAccumulatorRef.current.size).toBe(0);
  });
});

describe('handleThinkingStreaming', () => {
  it('clears thinking on message_start', () => {
    const msg: ClaudeMessage = {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { role: 'assistant', content: '' },
      },
    };

    expect(handleThinkingStreaming(msg)).toEqual({ type: 'THINKING_CLEAR' });
  });

  it('returns THINKING_DELTA for thinking_delta events', () => {
    const msg: ClaudeMessage = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'step-by-step' },
      },
    };

    expect(handleThinkingStreaming(msg)).toEqual({
      type: 'THINKING_DELTA',
      payload: { thinking: 'step-by-step' },
    });
  });
});

describe('isWebSocketMessage', () => {
  it('rejects unknown websocket message types', () => {
    expect(isWebSocketMessage({ type: 'not_real' })).toBe(false);
  });

  it('rejects session_delta payloads without nested websocket event', () => {
    expect(isWebSocketMessage({ type: 'session_delta', data: { foo: 'bar' } })).toBe(false);
    expect(isWebSocketMessage({ type: 'session_delta', data: null })).toBe(false);
  });

  it('accepts valid session_delta payloads', () => {
    expect(isWebSocketMessage({ type: 'session_delta', data: { type: 'status_update' } })).toBe(
      true
    );
  });
});
