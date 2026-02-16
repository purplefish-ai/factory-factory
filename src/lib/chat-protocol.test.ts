import { describe, expect, it } from 'vitest';
import type { AgentMessage, ChatMessage } from '@/lib/chat-protocol';
import { groupAdjacentToolCalls, isReasoningToolCall, isToolSequence } from '@/lib/chat-protocol';

function createToolUseMessage(params: {
  id: string;
  name: string;
  input: Record<string, unknown>;
  order: number;
}): ChatMessage {
  const agentMessage: AgentMessage = {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: params.id,
        name: params.name,
        input: params.input,
      },
    },
  };
  return {
    id: `msg-${params.order}`,
    source: 'agent',
    message: agentMessage,
    timestamp: '2026-02-16T00:00:00.000Z',
    order: params.order,
  };
}

function createToolResultMessage(toolUseId: string, order: number): ChatMessage {
  const agentMessage: AgentMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'ok',
        },
      ],
    },
  };
  return {
    id: `msg-${order}`,
    source: 'agent',
    message: agentMessage,
    timestamp: '2026-02-16T00:00:00.000Z',
    order,
  };
}

function createAssistantTextMessage(order: number): ChatMessage {
  const agentMessage: AgentMessage = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    },
  };
  return {
    id: `msg-${order}`,
    source: 'agent',
    message: agentMessage,
    timestamp: '2026-02-16T00:00:00.000Z',
    order,
  };
}

describe('groupAdjacentToolCalls', () => {
  it('filters reasoning tool calls from grouped tool sequences', () => {
    const grouped = groupAdjacentToolCalls([
      createToolUseMessage({
        id: 'reasoning-1',
        name: 'reasoning',
        input: { type: 'reasoning' },
        order: 0,
      }),
      createToolResultMessage('reasoning-1', 1),
      createToolUseMessage({
        id: 'read-1',
        name: 'Read',
        input: { file_path: 'src/app.ts' },
        order: 2,
      }),
      createToolResultMessage('read-1', 3),
      createAssistantTextMessage(4),
    ]);

    expect(grouped).toHaveLength(2);
    expect(isToolSequence(grouped[0]!)).toBe(true);
    if (isToolSequence(grouped[0]!)) {
      expect(grouped[0].pairedCalls).toHaveLength(1);
      expect(grouped[0].pairedCalls[0]?.name).toBe('Read');
    }
  });

  it('drops tool sequences that only contain reasoning calls', () => {
    const grouped = groupAdjacentToolCalls([
      createToolUseMessage({
        id: 'reasoning-1',
        name: 'reasoning',
        input: { type: 'reasoning' },
        order: 0,
      }),
      createToolResultMessage('reasoning-1', 1),
      createAssistantTextMessage(2),
    ]);

    expect(grouped).toHaveLength(1);
    expect(isToolSequence(grouped[0]!)).toBe(false);
  });
});

describe('isReasoningToolCall', () => {
  it('does not throw for malformed non-object input values', () => {
    expect(() => isReasoningToolCall('Bash', null)).not.toThrow();
    expect(() => isReasoningToolCall('Bash', 'oops')).not.toThrow();
    expect(() => isReasoningToolCall('Bash', 123)).not.toThrow();
    expect(() => isReasoningToolCall('Bash', ['reasoning'])).not.toThrow();
  });

  it('returns false for malformed non-reasoning input values', () => {
    expect(isReasoningToolCall('Bash', null)).toBe(false);
    expect(isReasoningToolCall('Bash', 'oops')).toBe(false);
    expect(isReasoningToolCall('Bash', 123)).toBe(false);
    expect(isReasoningToolCall('Bash', ['reasoning'])).toBe(false);
  });
});
