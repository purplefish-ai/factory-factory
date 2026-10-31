import { describe, expect, it, vi } from 'vitest';
import { sessionCommandFactories } from '@/backend/services/session';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { createChatCommandRegistry } from './chat-message-router';
import { createChatRouterServices } from './chat-message-router.test-helpers';

describe('socket-free command registry', () => {
  it('uses the supplied application capabilities for every migrated command', async () => {
    const sessionConfigService = {
      setSessionModel: vi.fn().mockResolvedValue(undefined),
      setSessionReasoningEffort: vi.fn().mockResolvedValue(undefined),
      getChatBarCapabilities: vi.fn().mockResolvedValue(EMPTY_CHAT_BAR_CAPABILITIES),
      setSessionThinkingBudget: vi.fn().mockResolvedValue(undefined),
      setSessionConfigOption: vi.fn().mockResolvedValue(undefined),
      getSessionConfigOptions: vi.fn(() => []),
    };
    const respondToPermission = vi.fn(() => true);
    const registry = createChatCommandRegistry({
      ...createChatRouterServices(sessionCommandFactories),
      execution: {
        domain: {
          markError: vi.fn(),
          rejectMessage: vi.fn(),
          enqueue: vi.fn(),
          emitDelta: vi.fn(),
          removeQueuedMessage: vi.fn(),
        },
        lifecycle: { getSessionOptions: vi.fn(), stopSession: vi.fn() },
        backgroundDelivery: {
          captureResumeGuard: () => () => true,
          userResume: vi.fn().mockResolvedValue(undefined),
        },
        clearPendingRequest: vi.fn(),
      },
      runtime: { isSessionRunning: () => false },
      config: sessionConfigService,
      permission: { respondToPermission },
      prompt: { sendSessionMessage: vi.fn() },
      startup: { getSessionClient: () => undefined, getOrCreateSessionClient: vi.fn() },
      dispatch: {
        steerQueuedMessage: vi.fn().mockResolvedValue(undefined),
        tryDispatchNextMessage: vi.fn(),
        setManualDispatchResume: vi.fn(),
        resetDispatchState: vi.fn(),
      },
    });
    const context = { sessionId: 'injected-session', workingDir: '/injected/worktree' };
    expect(
      await registry.set_model(context, {
        type: 'set_model',
        model: 'chosen',
        reasoningEffort: null,
      })
    ).toEqual({
      replies: [{ type: 'chat_capabilities', capabilities: EMPTY_CHAT_BAR_CAPABILITIES }],
    });
    await registry.set_thinking_budget(context, { type: 'set_thinking_budget', max_tokens: 12 });
    await registry.set_config_option(context, {
      type: 'set_config_option',
      configId: 'mode',
      value: 'plan',
    });
    await registry.permission_response(context, {
      type: 'permission_response',
      requestId: 'request',
      optionId: 'allow',
    });
    expect(sessionConfigService.setSessionModel).toHaveBeenCalledWith(
      'injected-session',
      'chosen',
      'user'
    );
    expect(sessionConfigService.setSessionReasoningEffort).toHaveBeenCalledWith(
      'injected-session',
      null,
      'user'
    );
    expect(sessionConfigService.getChatBarCapabilities).toHaveBeenCalledWith('injected-session');
    expect(sessionConfigService.setSessionThinkingBudget).toHaveBeenCalledWith(
      'injected-session',
      12
    );
    expect(sessionConfigService.setSessionConfigOption).toHaveBeenCalledWith(
      'injected-session',
      'mode',
      'plan'
    );
    expect(respondToPermission).toHaveBeenCalledWith(
      'injected-session',
      'request',
      'allow',
      undefined
    );
  });
});

it('routes execution commands using injected application capabilities and typed outcomes', async () => {
  const guard = () => true;
  const backgroundDelivery = {
    captureResumeGuard: vi.fn(() => guard),
    userResume: vi.fn().mockResolvedValue(undefined),
  };
  const domain = {
    markError: vi.fn(),
    rejectMessage: vi.fn(),
    enqueue: vi.fn(() => ({ position: 0 })),
    emitDelta: vi.fn(),
    removeQueuedMessage: vi.fn(() => true),
  };
  const lifecycle = {
    getSessionOptions: vi.fn().mockResolvedValue({ workspaceStatus: 'READY' }),
    stopSession: vi.fn().mockResolvedValue(undefined),
  };
  const clearPendingRequest = vi.fn();
  const resetDispatchState = vi.fn();
  const tryDispatchNextMessage = vi.fn().mockResolvedValue(undefined);
  const setManualDispatchResume = vi.fn();
  const sendSessionMessage = vi.fn().mockResolvedValue(undefined);
  const getOrCreateSessionClient = vi.fn().mockResolvedValue(undefined);
  const registry = createChatCommandRegistry({
    ...createChatRouterServices(sessionCommandFactories),
    execution: { backgroundDelivery, domain, lifecycle, clearPendingRequest },
    runtime: { isSessionRunning: () => true },
    prompt: { sendSessionMessage },
    startup: { getSessionClient: vi.fn(), getOrCreateSessionClient },
    config: {
      setSessionModel: vi.fn(),
      setSessionReasoningEffort: vi.fn(),
      getChatBarCapabilities: vi.fn(),
      setSessionThinkingBudget: vi.fn(),
      setSessionConfigOption: vi.fn(),
      getSessionConfigOptions: vi.fn(),
    },
    permission: { respondToPermission: vi.fn() },
    dispatch: {
      steerQueuedMessage: vi.fn(),
      resetDispatchState,
      tryDispatchNextMessage,
      setManualDispatchResume,
    },
  });
  const context = { sessionId: 'injected-execution', workingDir: '/injected' };
  expect(await registry.start(context, { type: 'start', model: 'requested' })).toEqual({
    replies: [],
  });
  expect(await registry.user_input(context, { type: 'user_input', text: 'direct' })).toEqual({
    replies: [],
  });
  expect(
    await registry.queue_message(context, { type: 'queue_message', id: 'queued', text: 'human' })
  ).toEqual({ replies: [] });
  expect(
    registry.remove_queued_message(context, { type: 'remove_queued_message', messageId: 'queued' })
  ).toEqual({ replies: [] });
  expect(
    await registry.resume_queued_messages(context, { type: 'resume_queued_messages' })
  ).toEqual({ replies: [] });
  expect(await registry.stop(context, { type: 'stop' })).toEqual({ replies: [] });
  expect(getOrCreateSessionClient).toHaveBeenCalledWith(
    'injected-execution',
    expect.objectContaining({ model: 'requested' })
  );
  expect(sendSessionMessage).toHaveBeenCalledWith('injected-execution', 'direct');
  expect(domain.enqueue).toHaveBeenCalledWith(
    'injected-execution',
    expect.objectContaining({ id: 'queued', text: 'human' })
  );
  expect(domain.removeQueuedMessage).toHaveBeenCalledWith('injected-execution', 'queued');
  expect(domain.emitDelta).toHaveBeenCalledTimes(2);
  expect(setManualDispatchResume).toHaveBeenCalledWith('injected-execution', true);
  expect(lifecycle.stopSession).toHaveBeenCalledWith('injected-execution', { reason: 'USER_STOP' });
  expect(clearPendingRequest).toHaveBeenCalledWith('injected-execution');
  expect(resetDispatchState).toHaveBeenCalledWith('injected-execution');
  expect(tryDispatchNextMessage).toHaveBeenCalledTimes(3);
  expect(backgroundDelivery.userResume).toHaveBeenCalledTimes(4);
  expect(backgroundDelivery.userResume).toHaveBeenNthCalledWith(4, 'injected-execution', guard);
});
