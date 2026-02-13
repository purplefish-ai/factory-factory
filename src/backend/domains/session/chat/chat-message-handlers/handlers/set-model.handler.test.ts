import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setSessionModel: vi.fn(),
  setSessionReasoningEffort: vi.fn(),
}));

vi.mock('@/backend/domains/session/lifecycle/session.service', () => ({
  sessionService: {
    setSessionModel: mocks.setSessionModel,
    setSessionReasoningEffort: mocks.setSessionReasoningEffort,
  },
}));

import { createSetModelHandler } from './set-model.handler';

describe('createSetModelHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setSessionModel.mockResolvedValue(undefined);
    mocks.setSessionReasoningEffort.mockResolvedValue(undefined);
  });

  it('applies model and reasoning effort when provided', async () => {
    const handler = createSetModelHandler();
    const ws = {
      send: vi.fn(),
    };

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/project',
      message: {
        type: 'set_model',
        model: 'gpt-5.3-codex',
        reasoningEffort: 'high',
      },
    });

    expect(mocks.setSessionModel).toHaveBeenCalledWith('session-1', 'gpt-5.3-codex');
    expect(mocks.setSessionReasoningEffort).toHaveBeenCalledWith('session-1', 'high');
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('does not update reasoning effort when field is omitted', async () => {
    const handler = createSetModelHandler();
    const ws = {
      send: vi.fn(),
    };

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/project',
      message: {
        type: 'set_model',
        model: 'gpt-5.3-codex',
      },
    });

    expect(mocks.setSessionModel).toHaveBeenCalledWith('session-1', 'gpt-5.3-codex');
    expect(mocks.setSessionReasoningEffort).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('sends websocket error when model update fails', async () => {
    const handler = createSetModelHandler();
    const ws = {
      send: vi.fn(),
    };
    mocks.setSessionModel.mockRejectedValue(new Error('boom'));

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/project',
      message: {
        type: 'set_model',
        model: 'gpt-5.3-codex',
        reasoningEffort: 'high',
      },
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Failed to set model: boom' })
    );
  });
});
