import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/lib/chat-protocol';
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
