import { describe, expect, it } from 'vitest';
import { type ChatAction, chatReducer, createInitialChatState } from './index';

const resultAction: Extract<ChatAction, { type: 'WS_AGENT_MESSAGE' }> = {
  type: 'WS_AGENT_MESSAGE',
  payload: {
    order: 42,
    message: {
      type: 'result',
      result: 'Done',
      usage: { input_tokens: 100, output_tokens: 50 },
      duration_ms: 1000,
    },
  },
};

describe('result delivery token accounting', () => {
  it('counts suppressed results once', () => {
    const withAssistant = chatReducer(createInitialChatState(), {
      type: 'WS_AGENT_MESSAGE',
      payload: {
        order: 41,
        message: { type: 'assistant', message: { role: 'assistant', content: 'Done' } },
      },
    });
    const once = chatReducer(withAssistant, resultAction);
    expect(once.messages).toHaveLength(1);
    expect(once.tokenStats.inputTokens).toBe(100);
    expect(chatReducer(once, resultAction).tokenStats).toEqual(once.tokenStats);
  });

  it('remembers counted results after the renderer trims them', () => {
    const once = chatReducer(createInitialChatState({ rendererTranscriptLimit: 1 }), resultAction);
    const trimmed = chatReducer(once, {
      type: 'WS_AGENT_MESSAGE',
      payload: {
        order: 43,
        message: { type: 'assistant', message: { role: 'assistant', content: 'Next turn' } },
      },
    });
    expect(trimmed.messages.some((message) => message.order === 42)).toBe(false);
    expect(chatReducer(trimmed, resultAction).tokenStats).toEqual(once.tokenStats);
  });

  it.each(['CLEAR_CHAT', 'RESET_FOR_SESSION_SWITCH', 'SESSION_SWITCH_START'] as const)(
    'allows the same order to count after %s resets usage',
    (type) => {
      const once = chatReducer(createInitialChatState(), resultAction);
      const reset = chatReducer(once, { type });
      expect(reset.tokenStats.inputTokens).toBe(0);
      expect(chatReducer(reset, resultAction).tokenStats).toEqual(once.tokenStats);
    }
  );

  it('reconstructs counted results during replay hydration', () => {
    const once = chatReducer(createInitialChatState(), resultAction);
    const replayed = chatReducer(once, {
      type: 'SESSION_REPLAY_BATCH',
      payload: {
        replayEvents: [{ type: 'agent_message', data: resultAction.payload.message, order: 42 }],
      },
    });
    expect(replayed.tokenStats).toEqual(once.tokenStats);
    expect(chatReducer(replayed, resultAction).tokenStats).toEqual(once.tokenStats);
  });

  it('counts a same-order result once while retaining distinct results', () => {
    const action: ChatAction = {
      type: 'WS_AGENT_MESSAGE',
      payload: {
        order: 42,
        message: {
          type: 'result',
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 100,
          },
          duration_ms: 2000,
          duration_api_ms: 1500,
          total_cost_usd: 0.05,
          num_turns: 1,
        },
      },
    };
    const once = chatReducer(createInitialChatState(), action);
    const twice = chatReducer(once, action);
    expect(twice.messages).toHaveLength(1);
    expect(twice.tokenStats).toEqual(once.tokenStats);
    const next = chatReducer(twice, { ...action, payload: { ...action.payload, order: 43 } });
    expect(next.tokenStats.inputTokens).toBe(2000);
    expect(next.tokenStats.outputTokens).toBe(1000);
  });
});
