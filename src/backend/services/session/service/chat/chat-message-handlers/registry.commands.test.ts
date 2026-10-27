import { describe, expect, it, vi } from 'vitest';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { createChatMessageHandlerRegistry } from './registry';

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
    const registry = createChatMessageHandlerRegistry({
      acpRuntimeManager: { isSessionRunning: () => false },
      sessionConfigService,
      sessionPermissionService: { respondToPermission },
      sessionService: { sendSessionMessage: vi.fn() },
      startupService: { getSessionClient: () => undefined, getOrCreateSessionClient: vi.fn() },
      tryDispatchNextMessage: vi.fn(),
      setManualDispatchResume: vi.fn(),
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
    expect(sessionConfigService.setSessionModel).toHaveBeenCalledWith('injected-session', 'chosen');
    expect(sessionConfigService.setSessionReasoningEffort).toHaveBeenCalledWith(
      'injected-session',
      null
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
