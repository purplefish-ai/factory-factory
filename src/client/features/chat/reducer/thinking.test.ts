import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/lib/chat-protocol';
import { MessageState } from '@/lib/chat-protocol';
import {
  AcpEventTranslator,
  type TranslatableSessionUpdate,
} from '@/shared/acp-protocol/session-update-translator';
import { chatReducer, createInitialChatState } from './index';

const thought = (text: string): AgentMessage => ({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: text },
  },
});

describe('live thinking sequences', () => {
  it('ignores stale and duplicate thinking deltas while accepting the first delta at its block start order', () => {
    let state = chatReducer(createInitialChatState(), {
      type: 'WS_AGENT_MESSAGE',
      payload: {
        order: 0,
        message: {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: 'Current ' },
          },
        },
      },
    });
    const first = {
      type: 'WS_AGENT_MESSAGE' as const,
      payload: { message: thought('block'), order: 0 },
    };
    state = chatReducer(state, first);
    expect(state.latestThinking).toBe('Current block');
    state = chatReducer(state, first);
    expect(state.latestThinking).toBe('Current block');
    const event = state.messages[0]?.message?.event;
    expect(
      event?.type === 'content_block_start' && event.content_block.type === 'thinking'
        ? event.content_block.thinking
        : null
    ).toBe('Current block');
    state = chatReducer(state, {
      type: 'WS_ASSISTANT_TEXT_DELTA',
      payload: { messageId: 'new-text', order: 2, offset: 0, text: 'Next step' },
    });
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: thought('Old reasoning'), order: 1 },
    });
    expect(state.latestThinking).toBeNull();
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: {
        order: 3,
        message: {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '' },
          },
        },
      },
    });
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: thought('New thinking'), order: 4 },
    });
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: thought(' stale chunk'), order: 3 },
    });
    expect(state.latestThinking).toBe('New thinking');
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: thought(' continued'), order: 5 },
    });
    expect(state.latestThinking).toBe('New thinking continued');
    const storedThinking = state.messages.flatMap((message) => {
      const event = message.message?.event;
      return event?.type === 'content_block_start' && event.content_block.type === 'thinking'
        ? [event.content_block.thinking]
        : [];
    });
    expect(storedThinking).toEqual(['Current block', 'New thinking continued']);
  });

  it('keeps replay protection across accepted user turns, then resets on a session switch', () => {
    let state = chatReducer(createInitialChatState(), {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: thought('Old turn'), order: 10 },
    });
    state = chatReducer(state, {
      type: 'MESSAGE_STATE_CHANGED',
      payload: { id: 'queued', newState: MessageState.ACCEPTED },
    });
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: thought('New turn'), order: 11 },
    });
    state = chatReducer(state, {
      type: 'WS_ASSISTANT_TEXT_DELTA',
      payload: { messageId: 'old', order: 5, offset: 0, text: 'Old text' },
    });
    expect(state.latestThinking).toBe('New turn');
    state = chatReducer(state, { type: 'RESET_FOR_SESSION_SWITCH' });
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: thought('New session'), order: 0 },
    });
    state = chatReducer(state, {
      type: 'WS_ASSISTANT_TEXT_DELTA',
      payload: { messageId: 'fresh', order: 1, offset: 0, text: 'Fresh text' },
    });
    expect(state.latestThinking).toBeNull();
  });

  it('seeds snapshot replay protection from agent orders while ignoring queued user orders', () => {
    let state = createInitialChatState({
      latestThinking: 'Stale preview',
      latestThinkingOrder: 100,
      latestThinkingDeltaOrder: 100,
      rendererTranscriptLimit: 1,
    });
    state = chatReducer(state, {
      type: 'SESSION_SNAPSHOT',
      payload: {
        sessionRuntime: state.sessionRuntime,
        queuedMessages: [],
        messages: [
          {
            id: 'snapshot-text',
            source: 'agent',
            order: 10,
            timestamp: '2026-11-03T00:00:00Z',
            message: {
              type: 'assistant',
              message: { role: 'assistant', content: [{ type: 'text', text: 'Snapshot text' }] },
            },
          },
          {
            id: 'queued',
            source: 'user',
            order: 1_000_000_000,
            timestamp: '2026-11-03T00:00:00Z',
            text: 'Queued input',
          },
        ],
      },
    });
    expect(state.latestThinking).toBeNull();
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: thought('Current'), order: 11 },
    });
    state = chatReducer(state, {
      type: 'WS_ASSISTANT_TEXT_DELTA',
      payload: { messageId: 'snapshot-text', order: 10, offset: 0, text: 'Snapshot text' },
    });
    expect(state.latestThinking).toBe('Current');
    state = chatReducer(state, {
      type: 'WS_ASSISTANT_TEXT_DELTA',
      payload: { messageId: 'next', order: 12, offset: 0, text: 'Next text' },
    });
    expect(state.latestThinking).toBeNull();
  });

  it('reconstructs thinking order when a replay batch replaces the session transcript', () => {
    let state = createInitialChatState({
      latestThinking: 'Stale',
      latestThinkingOrder: 100,
      latestThinkingDeltaOrder: 100,
    });
    state = chatReducer(state, {
      type: 'SESSION_REPLAY_BATCH',
      payload: {
        replayEvents: [{ type: 'agent_message', order: 0, data: thought('Replayed thought') }],
      },
    });
    expect(state.latestThinking).toBe('Replayed thought');
    state = chatReducer(state, {
      type: 'WS_ASSISTANT_TEXT_DELTA',
      payload: { messageId: 'next', order: 1, offset: 0, text: 'Next text' },
    });
    expect(state.latestThinking).toBeNull();
  });

  it.each(['text', 'tool'] as const)(
    'preserves newer thinking when a trimmed %s start is replayed',
    (kind) => {
      const tool: AgentMessage = {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'old-tool', name: 'Terminal', input: {} },
        },
      };
      const oldAction =
        kind === 'text'
          ? {
              type: 'WS_ASSISTANT_TEXT_DELTA' as const,
              payload: { messageId: 'old-text', order: 0, offset: 0, text: 'Old commentary' },
            }
          : { type: 'WS_AGENT_MESSAGE' as const, payload: { message: tool, order: 0 } };
      let state = chatReducer(createInitialChatState({ rendererTranscriptLimit: 1 }), oldAction);
      state = chatReducer(state, {
        type: 'WS_ASSISTANT_TEXT_DELTA',
        payload: { messageId: 'new-text', order: 1, offset: 0, text: 'New commentary' },
      });
      expect(state.agentMessageOrderToIndex.has(0)).toBe(false);
      state = chatReducer(state, {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: thought('Current '), order: 2 },
      });
      state = chatReducer(state, {
        type: 'WS_AGENT_MESSAGE',
        payload: { message: thought('block'), order: 3 },
      });
      state = chatReducer(state, oldAction);
      expect(state.latestThinking).toBe('Current block');
      state = chatReducer(state, {
        type: 'WS_ASSISTANT_TEXT_DELTA',
        payload: { messageId: 'next-text', order: 4, offset: 0, text: 'Next commentary' },
      });
      expect(state.latestThinking).toBeNull();
    }
  );

  it.each<TranslatableSessionUpdate>([
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'shell-1',
      title: 'Terminal',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'gh pr view' },
    },
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'The first check passed.' },
    },
  ])('starts fresh after $sessionUpdate without a legacy message_start', (boundary) => {
    const translator = new AcpEventTranslator({ warn: () => undefined });
    let state = createInitialChatState();
    let order = 0;
    for (const update of [
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: '**Preparing PR body**' },
      },
      boundary,
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '**Fetching ' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'comments**' } },
    ] satisfies TranslatableSessionUpdate[]) {
      for (const delta of translator.translateSessionUpdate(update, 'session-1')) {
        if (delta.type === 'agent_message') {
          state = chatReducer(state, {
            type: 'WS_AGENT_MESSAGE',
            payload: { message: delta.data, order: order++ },
          });
        }
      }
    }
    expect(state.latestThinking).toBe('**Fetching comments**');
  });

  it('starts fresh at an explicit thinking block and retains its initial text', () => {
    let state = createInitialChatState({ latestThinking: 'Previous block' });
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: {
        order: 0,
        message: {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: 'Current ' },
          },
        },
      },
    });
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: thought('block'), order: 1 },
    });
    expect(state.latestThinking).toBe('Current block');
  });

  it('starts fresh after the optimized assistant text transport', () => {
    let state = createInitialChatState({ latestThinking: 'Previous block' });
    state = chatReducer(state, {
      type: 'WS_ASSISTANT_TEXT_DELTA',
      payload: { messageId: 'text-1', order: 0, offset: 0, text: 'Checking CI.' },
    });
    expect(state.latestThinking).toBeNull();
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: thought('Current block'), order: 1 },
    });
    expect(state.latestThinking).toBe('Current block');
    // Duplicate text delivery must not clear a newer thinking sequence.
    state = chatReducer(state, {
      type: 'WS_ASSISTANT_TEXT_DELTA',
      payload: { messageId: 'text-1', order: 0, offset: 0, text: 'Checking CI.' },
    });
    expect(state.latestThinking).toBe('Current block');
  });

  it('keeps a current sequence through background tool results and replayed tool starts', () => {
    const tool: AgentMessage = {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'shell-1', name: 'Terminal', input: {} },
      },
    };
    let state = chatReducer(createInitialChatState(), {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: tool, order: 0 },
    });
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: thought('Current '), order: 1 },
    });
    state = chatReducer(state, { type: 'WS_AGENT_MESSAGE', payload: { message: tool, order: 0 } });
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: {
        order: 2,
        message: {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'shell-1', content: 'Done' }],
          },
        },
      },
    });
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: thought('block'), order: 3 },
    });
    expect(state.latestThinking).toBe('Current block');
  });

  it('ignores replayed unpersisted text block starts', () => {
    const textStart: AgentMessage = {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    };
    let state = chatReducer(createInitialChatState(), {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: textStart, order: 0 },
    });
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: thought('Current block'), order: 1 },
    });
    state = chatReducer(state, {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: textStart, order: 0 },
    });
    expect(state.latestThinking).toBe('Current block');
  });
});
