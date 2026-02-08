import { describe, expect, it } from 'vitest';
import { type ClaudeMessage, isWebSocketMessage } from '@/lib/claude-types';
import { createToolInputAccumulatorState, handleToolInputStreaming } from './streaming-utils';

describe('handleToolInputStreaming', () => {
  it('accumulates input_json_delta and returns TOOL_INPUT_UPDATE when JSON is complete', () => {
    const toolInputAccumulatorRef = { current: createToolInputAccumulatorState() };

    const startMsg: ClaudeMessage = {
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

    const partialMsg: ClaudeMessage = {
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

  it('cleans up accumulator entries on content_block_stop', () => {
    const toolInputAccumulatorRef = { current: createToolInputAccumulatorState() };
    const startMsg: ClaudeMessage = {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 3,
        content_block: { type: 'tool_use', id: 'tool-3', name: 'search', input: {} },
      },
    };
    handleToolInputStreaming(startMsg, toolInputAccumulatorRef);

    const stopMsg: ClaudeMessage = {
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 3 },
    };
    handleToolInputStreaming(stopMsg, toolInputAccumulatorRef);

    expect(toolInputAccumulatorRef.current.toolUseIdByIndex.has(3)).toBe(false);
    expect(toolInputAccumulatorRef.current.inputJsonByToolUseId.has('tool-3')).toBe(false);
  });

  it('returns null when message is not a stream_event', () => {
    const toolInputAccumulatorRef = { current: createToolInputAccumulatorState() };
    const nonStream: ClaudeMessage = {
      type: 'assistant',
      message: { role: 'assistant', content: 'ok' },
    };

    expect(handleToolInputStreaming(nonStream, toolInputAccumulatorRef)).toBeNull();
    expect(toolInputAccumulatorRef.current.toolUseIdByIndex.size).toBe(0);
    expect(toolInputAccumulatorRef.current.inputJsonByToolUseId.size).toBe(0);
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

  it('rejects non-delta nested payload types inside session_delta', () => {
    expect(isWebSocketMessage({ type: 'session_delta', data: { type: 'session_snapshot' } })).toBe(
      false
    );
    expect(
      isWebSocketMessage({ type: 'session_delta', data: { type: 'session_replay_batch' } })
    ).toBe(false);
    expect(isWebSocketMessage({ type: 'session_delta', data: { type: 'session_delta' } })).toBe(
      false
    );
  });

  it('rejects claude_message without a nested Claude payload', () => {
    expect(isWebSocketMessage({ type: 'claude_message' })).toBe(false);
    expect(isWebSocketMessage({ type: 'claude_message', data: null })).toBe(false);
    expect(isWebSocketMessage({ type: 'claude_message', data: { type: 'not_real' } })).toBe(false);
  });
});
