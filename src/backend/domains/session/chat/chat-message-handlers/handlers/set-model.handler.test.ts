import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessageHandlerSessionService } from '@/backend/domains/session/chat/chat-message-handlers/types';

const mocks = vi.hoisted(() => ({
  setSessionModel: vi.fn(),
  setSessionReasoningEffort: vi.fn(),
  getChatBarCapabilities: vi.fn(),
}));

import { createSetModelHandler } from './set-model.handler';

describe('createSetModelHandler', () => {
  const deps: { sessionService: ChatMessageHandlerSessionService } = {
    sessionService: {
      isSessionRunning: vi.fn(),
      sendSessionMessage: vi.fn(),
      respondToAcpPermission: vi.fn(),
      setSessionModel: mocks.setSessionModel,
      setSessionReasoningEffort: mocks.setSessionReasoningEffort,
      getChatBarCapabilities: mocks.getChatBarCapabilities,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setSessionModel.mockResolvedValue(undefined);
    mocks.setSessionReasoningEffort.mockResolvedValue(undefined);
    mocks.getChatBarCapabilities.mockResolvedValue({
      provider: 'CODEX',
      model: { enabled: true, options: [], selected: 'gpt-5' },
      reasoning: { enabled: false, options: [] },
      thinking: { enabled: false },
      planMode: { enabled: true },
      attachments: { enabled: false, kinds: [] },
      slashCommands: { enabled: false },
      usageStats: { enabled: false, contextWindow: false },
      rewind: { enabled: false },
    });
  });

  it('applies model and reasoning effort when provided', async () => {
    const handler = createSetModelHandler(deps);
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
    expect(mocks.getChatBarCapabilities).toHaveBeenCalledWith('session-1');
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'chat_capabilities',
        capabilities: {
          provider: 'CODEX',
          model: { enabled: true, options: [], selected: 'gpt-5' },
          reasoning: { enabled: false, options: [] },
          thinking: { enabled: false },
          planMode: { enabled: true },
          attachments: { enabled: false, kinds: [] },
          slashCommands: { enabled: false },
          usageStats: { enabled: false, contextWindow: false },
          rewind: { enabled: false },
        },
      })
    );
  });

  it('does not update reasoning effort when field is omitted', async () => {
    const handler = createSetModelHandler(deps);
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
    expect(mocks.getChatBarCapabilities).toHaveBeenCalledWith('session-1');
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('sends websocket error when model update fails', async () => {
    const handler = createSetModelHandler(deps);
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
