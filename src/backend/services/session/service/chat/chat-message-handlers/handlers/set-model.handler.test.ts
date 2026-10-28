import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionModelCommandService } from '@/backend/services/session/service/chat/session-command.types';

const mocks = vi.hoisted(() => ({
  setSessionModel: vi.fn(),
  setSessionReasoningEffort: vi.fn(),
  getChatBarCapabilities: vi.fn(),
}));

import { createSetModelHandler } from './set-model.handler';

describe('createSetModelHandler', () => {
  const deps: { sessionConfigService: SessionModelCommandService } = {
    sessionConfigService: {
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

    const outcome = await handler(
      {
        sessionId: 'session-1',
        workingDir: '/tmp/project',
      },
      {
        type: 'set_model',
        model: 'gpt-5.3-codex',
        reasoningEffort: 'high',
      }
    );

    expect(mocks.setSessionModel).toHaveBeenCalledWith('session-1', 'gpt-5.3-codex', 'user');
    expect(mocks.setSessionReasoningEffort).toHaveBeenCalledWith('session-1', 'high', 'user');
    expect(mocks.getChatBarCapabilities).toHaveBeenCalledWith('session-1');
    expect(outcome).toEqual({
      replies: [
        {
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
        },
      ],
    });
  });

  it('does not update reasoning effort when field is omitted', async () => {
    const handler = createSetModelHandler(deps);

    const outcome = await handler(
      {
        sessionId: 'session-1',
        workingDir: '/tmp/project',
      },
      {
        type: 'set_model',
        model: 'gpt-5.3-codex',
      }
    );

    expect(mocks.setSessionModel).toHaveBeenCalledWith('session-1', 'gpt-5.3-codex', 'user');
    expect(mocks.setSessionReasoningEffort).not.toHaveBeenCalled();
    expect(mocks.getChatBarCapabilities).toHaveBeenCalledWith('session-1');
    expect(outcome.replies).toHaveLength(1);
  });

  it('does not submit a model edit for a reasoning-only request', async () => {
    await createSetModelHandler(deps)(
      { sessionId: 'session-1', workingDir: '/tmp/project' },
      {
        type: 'set_model',
        reasoningEffort: 'high',
      }
    );
    expect(mocks.setSessionModel).not.toHaveBeenCalled();
    expect(mocks.setSessionReasoningEffort).toHaveBeenCalledWith('session-1', 'high', 'user');
  });

  it.each([undefined, 'model-request'])(
    'returns the model failure with requester correlation %s',
    async (requestId) => {
      const handler = createSetModelHandler(deps);
      mocks.setSessionModel.mockRejectedValue(new Error('boom'));

      const outcome = await handler(
        {
          sessionId: 'session-1',
          workingDir: '/tmp/project',
        },
        {
          type: 'set_model',
          ...(requestId !== undefined ? { requestId } : {}),
          model: 'gpt-5.3-codex',
          reasoningEffort: 'high',
        }
      );

      expect(outcome.replies).toEqual([
        {
          type: 'error',
          error: { kind: 'set_model_failed', cause: new Error('boom') },
          ...(requestId !== undefined ? { requestId } : {}),
        },
      ]);
    }
  );
});
