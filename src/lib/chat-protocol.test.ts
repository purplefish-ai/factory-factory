import { describe, expect, it } from 'vitest';
import type { AgentMessage, ChatMessage } from '@/lib/chat-protocol';
import {
  filterDuplicateResultMessages,
  groupAdjacentToolCalls,
  isReasoningToolCall,
  isToolSequence,
  isWebSocketMessage,
} from '@/lib/chat-protocol';

type LifecycleAgentMessage = Extract<AgentMessage, { type: 'session_lifecycle' }>;

const validLifecycleAgentMessage: LifecycleAgentMessage = {
  type: 'session_lifecycle',
  lifecycle: {
    eventId: 'event-1',
    kind: 'SESSION_STOPPED',
    reason: 'SYSTEM_STOP',
    message: 'Session stopped by the system.',
    timestamp: '2026-07-30T12:22:23.353Z',
  },
};

describe('sub-agent change websocket validation', () => {
  it('accepts direct and session-delta-wrapped invalidations', () => {
    const invalidation = {
      type: 'subagents_changed',
      sessionId: 'db-session-1',
      subagentId: 'child-1',
      change: 'completed',
    };

    expect(isWebSocketMessage(invalidation)).toBe(true);
    expect(isWebSocketMessage({ type: 'session_delta', data: invalidation })).toBe(true);
  });

  it.each([
    ['missing sessionId', { type: 'subagents_changed', subagentId: 'child-1', change: 'updated' }],
    [
      'empty sessionId',
      { type: 'subagents_changed', sessionId: '', subagentId: 'child-1', change: 'updated' },
    ],
    [
      'missing subagentId',
      { type: 'subagents_changed', sessionId: 'db-session-1', change: 'updated' },
    ],
    [
      'empty subagentId',
      { type: 'subagents_changed', sessionId: 'db-session-1', subagentId: '', change: 'updated' },
    ],
    [
      'invalid change',
      {
        type: 'subagents_changed',
        sessionId: 'db-session-1',
        subagentId: 'child-1',
        change: 'deleted',
      },
    ],
  ])('rejects direct and session-delta-wrapped invalidations with %s', (_label, invalidation) => {
    expect(isWebSocketMessage(invalidation)).toBe(false);
    expect(isWebSocketMessage({ type: 'session_delta', data: invalidation })).toBe(false);
  });
});

describe('session lifecycle websocket validation', () => {
  it('accepts the complete discriminated lifecycle payload', () => {
    expect(
      isWebSocketMessage({
        type: 'agent_message',
        data: validLifecycleAgentMessage,
      })
    ).toBe(true);
  });

  it.each([
    ['missing lifecycle', undefined],
    [
      'empty event id',
      {
        ...validLifecycleAgentMessage.lifecycle,
        eventId: '',
      },
    ],
    [
      'invalid kind',
      {
        ...validLifecycleAgentMessage.lifecycle,
        kind: 'UNKNOWN_KIND',
      },
    ],
    [
      'invalid reason',
      {
        ...validLifecycleAgentMessage.lifecycle,
        reason: 'UNKNOWN_REASON',
      },
    ],
    [
      'empty copy',
      {
        ...validLifecycleAgentMessage.lifecycle,
        message: '',
      },
    ],
    [
      'invalid timestamp',
      {
        ...validLifecycleAgentMessage.lifecycle,
        timestamp: 'not-a-timestamp',
      },
    ],
  ])('rejects %s', (_label, lifecycle) => {
    expect(
      isWebSocketMessage({
        type: 'agent_message',
        data: {
          type: 'session_lifecycle',
          ...(lifecycle === undefined ? {} : { lifecycle }),
        },
      })
    ).toBe(false);
  });

  it('validates lifecycle rows carried by authoritative session snapshots', () => {
    const lifecycleRow = {
      id: 'session-lifecycle:event-1',
      source: 'agent',
      timestamp: validLifecycleAgentMessage.lifecycle.timestamp,
      order: 0,
      message: validLifecycleAgentMessage,
    };

    expect(isWebSocketMessage({ type: 'session_snapshot', messages: [lifecycleRow] })).toBe(true);
    expect(
      isWebSocketMessage({
        type: 'session_snapshot',
        messages: [
          {
            ...lifecycleRow,
            message: {
              ...validLifecycleAgentMessage,
              lifecycle: {
                ...validLifecycleAgentMessage.lifecycle,
                reason: 'UNKNOWN_REASON',
              },
            },
          },
        ],
      })
    ).toBe(false);
  });

  it.each([
    ['null', null],
    ['string', 'invalid'],
    ['number', 42],
    ['boolean', true],
  ])('rejects %s entries in authoritative session snapshots', (_label, message) => {
    expect(isWebSocketMessage({ type: 'session_snapshot', messages: [message] })).toBe(false);
  });
});

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

  it('reconciles delayed tool_result events for previously flushed sequences', () => {
    const grouped = groupAdjacentToolCalls([
      createToolUseMessage({
        id: 'call-1',
        name: 'exec_command',
        input: { cmd: 'git commit -m "test"' },
        order: 0,
      }),
      createAssistantTextMessage(1),
      createToolResultMessage('call-1', 2),
      createAssistantTextMessage(3),
    ]);

    expect(grouped).toHaveLength(3);
    expect(isToolSequence(grouped[0]!)).toBe(true);
    if (isToolSequence(grouped[0]!)) {
      expect(grouped[0].pairedCalls).toHaveLength(1);
      expect(grouped[0].pairedCalls[0]?.id).toBe('call-1');
      expect(grouped[0].pairedCalls[0]?.status).toBe('success');
    }
  });
});

describe('isReasoningToolCall', () => {
  it('does not throw for malformed non-string tool names', () => {
    expect(() => isReasoningToolCall(null, {})).not.toThrow();
    expect(() => isReasoningToolCall(123, {})).not.toThrow();
    expect(() => isReasoningToolCall({}, {})).not.toThrow();
  });

  it('returns false for malformed non-string tool names', () => {
    expect(isReasoningToolCall(null, {})).toBe(false);
    expect(isReasoningToolCall(123, {})).toBe(false);
    expect(isReasoningToolCall({}, {})).toBe(false);
  });

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

describe('filterDuplicateResultMessages', () => {
  function makeUser(order: number): ChatMessage {
    return {
      id: `user-${order}`,
      source: 'user',
      text: 'hello',
      timestamp: '2026-02-16T00:00:00.000Z',
      order,
    };
  }

  function makeAssistant(text: string, order: number): ChatMessage {
    return {
      id: `assistant-${order}`,
      source: 'agent',
      message: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      },
      timestamp: '2026-02-16T00:00:00.000Z',
      order,
    };
  }

  function makeResult(text: string, order: number): ChatMessage {
    return {
      id: `result-${order}`,
      source: 'agent',
      message: { type: 'result', result: text },
      timestamp: '2026-02-16T00:00:00.000Z',
      order,
    };
  }

  it('filters result that duplicates preceding assistant text', () => {
    const messages = [makeUser(0), makeAssistant('hello', 1), makeResult('hello', 2)];
    const filtered = filterDuplicateResultMessages(messages);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((m) => m.id)).toEqual(['user-0', 'assistant-1']);
  });

  it('keeps result with different text than preceding assistant', () => {
    const messages = [makeUser(0), makeAssistant('hello', 1), makeResult('goodbye', 2)];
    const filtered = filterDuplicateResultMessages(messages);
    expect(filtered).toHaveLength(3);
  });

  it('keeps result with empty text (metadata-only)', () => {
    const messages = [makeUser(0), makeAssistant('hello', 1), makeResult('', 2)];
    const filtered = filterDuplicateResultMessages(messages);
    expect(filtered).toHaveLength(3);
  });

  it('keeps result when there is no preceding assistant', () => {
    const messages = [makeUser(0), makeResult('hello', 1)];
    const filtered = filterDuplicateResultMessages(messages);
    expect(filtered).toHaveLength(2);
  });

  it('does not look past a user message boundary', () => {
    const messages = [makeAssistant('hello', 0), makeUser(1), makeResult('hello', 2)];
    const filtered = filterDuplicateResultMessages(messages);
    expect(filtered).toHaveLength(3);
  });

  it('does not look past a result message boundary (previous turn)', () => {
    const messages = [
      makeAssistant('hello', 0),
      makeResult('hello', 1),
      makeAssistant('world', 2),
      makeResult('hello', 3),
    ];
    const filtered = filterDuplicateResultMessages(messages);
    // result at order 1 is a dup of assistant at order 0 → filtered
    // result at order 3 text "hello" does NOT match assistant at order 2 "world",
    // and the scan must not cross the result boundary at order 1 to reach assistant at order 0
    expect(filtered).toHaveLength(3);
    expect(filtered.map((m) => m.id)).toEqual(['assistant-0', 'assistant-2', 'result-3']);
  });
});
