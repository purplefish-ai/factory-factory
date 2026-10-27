import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSetThinkingBudgetHandler } from './set-thinking-budget.handler';

const setSessionThinkingBudget = vi.fn();
const handler = createSetThinkingBudgetHandler({
  sessionConfigService: { setSessionThinkingBudget },
});
const context = { sessionId: 'session-1', workingDir: '/tmp/work' };

describe('createSetThinkingBudgetHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates the injected session thinking budget without a socket', async () => {
    setSessionThinkingBudget.mockResolvedValue(undefined);
    expect(await handler(context, { type: 'set_thinking_budget', max_tokens: 12_000 })).toEqual({
      replies: [],
    });
    expect(setSessionThinkingBudget).toHaveBeenCalledWith('session-1', 12_000);
  });

  it('returns the failed update for transport error formatting', async () => {
    const cause = new Error('invalid token budget');
    setSessionThinkingBudget.mockRejectedValue(cause);
    expect(await handler(context, { type: 'set_thinking_budget', max_tokens: 0 })).toEqual({
      replies: [{ type: 'error', error: { kind: 'set_thinking_budget_failed', cause } }],
    });
  });
});
