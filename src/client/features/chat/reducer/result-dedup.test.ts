import { describe, expect, it } from 'vitest';
import { type ChatAction, chatReducer, createInitialChatState } from '../reducer';

describe('result delivery token accounting', () => {
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
