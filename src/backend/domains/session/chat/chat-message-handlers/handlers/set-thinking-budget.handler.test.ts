import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setSessionThinkingBudget: vi.fn(),
}));

vi.mock('@/backend/domains/session/lifecycle/session.service', () => ({
  sessionService: {
    setSessionThinkingBudget: mocks.setSessionThinkingBudget,
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createSetThinkingBudgetHandler } from './set-thinking-budget.handler';

describe('createSetThinkingBudgetHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates session thinking budget', async () => {
    mocks.setSessionThinkingBudget.mockResolvedValue(undefined);
    const ws = { send: vi.fn() };
    const handler = createSetThinkingBudgetHandler();

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'set_thinking_budget', max_tokens: 12_000 } as never,
    });

    expect(mocks.setSessionThinkingBudget).toHaveBeenCalledWith('session-1', 12_000);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('sends websocket error when update fails', async () => {
    mocks.setSessionThinkingBudget.mockRejectedValue(new Error('invalid token budget'));
    const ws = { send: vi.fn() };
    const handler = createSetThinkingBudgetHandler();

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'set_thinking_budget', max_tokens: 0 } as never,
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'error',
        message: 'Failed to set thinking budget: invalid token budget',
      })
    );
  });
});
