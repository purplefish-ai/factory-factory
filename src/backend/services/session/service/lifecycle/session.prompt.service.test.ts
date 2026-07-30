import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionDomainService } from '@/backend/services/session';
import { PromptTimeoutError } from '@/backend/services/session/service/acp';
import { AcpEventProcessor } from './acp-event-processor';
import { SessionService } from './session.service';
import { SessionLifecycleEventService } from './session-lifecycle-event.service';

function createPromptService() {
  const runtimeManager = {
    getClient: vi.fn(),
    sendPrompt: vi.fn(),
  };
  const sessionDomainService = {
    setRuntimeSnapshot: vi.fn(),
  };
  const acpEventProcessor = {
    getWorkspaceId: vi.fn().mockReturnValue('workspace-1'),
    getProvider: vi.fn().mockReturnValue('CODEX'),
    beginPromptTurn: vi.fn().mockReturnValue('attempt-key'),
    finishPromptTurn: vi.fn(),
    finalizeOrphanedToolCalls: vi.fn(),
  };
  const lifecycleEventService = {
    record: vi.fn().mockResolvedValue(undefined),
  };
  const promptTurnCompletionService = {
    schedule: vi.fn(),
  };
  const isSessionStopping = vi.fn().mockReturnValue(false);
  const service = new SessionService({
    runtimeManager: runtimeManager as never,
    sessionDomainService: sessionDomainService as never,
    acpEventProcessor: acpEventProcessor as never,
    promptTurnCompletionService: promptTurnCompletionService as never,
    lifecycleEventService: lifecycleEventService as never,
    getStopGeneration: () => 0,
    isSessionStopping,
  });

  return {
    service,
    runtimeManager,
    sessionDomainService,
    acpEventProcessor,
    lifecycleEventService,
    promptTurnCompletionService,
    isSessionStopping,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SessionService prompt coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when sendSessionMessage is called without an ACP client', async () => {
    const { service, runtimeManager } = createPromptService();
    runtimeManager.getClient.mockReturnValue(undefined);
    const sendAcpMessageSpy = vi.spyOn(service, 'sendAcpMessage');

    await expect(service.sendSessionMessage('session-1', 'hello')).rejects.toThrow(
      'No ACP client found for sendSessionMessage: session-1'
    );
    expect(sendAcpMessageSpy).not.toHaveBeenCalled();
  });

  it('converts supported content into ACP blocks', async () => {
    const { service, runtimeManager } = createPromptService();
    runtimeManager.getClient.mockReturnValue({ supportsImages: () => true });
    const sendAcpMessageSpy = vi
      .spyOn(service, 'sendAcpMessage')
      .mockResolvedValue('end_turn' as never);

    await service.sendSessionMessage('session-1', [
      { type: 'text', text: 'hello' },
      { type: 'thinking', thinking: 'analyzing' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      { type: 'tool_result', content: 'tool output' },
      { type: 'tool_result', content: { ok: true } },
      { type: 'unsupported' } as never,
    ] as never);

    expect(sendAcpMessageSpy).toHaveBeenCalledWith(
      'session-1',
      [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'analyzing' },
        { type: 'image', data: 'abc', mimeType: 'image/png' },
        { type: 'text', text: 'tool output' },
        { type: 'text', text: '{"ok":true}' },
      ],
      14_400_000
    );
  });

  it('uses a text placeholder when the provider does not support images', async () => {
    const { service, runtimeManager } = createPromptService();
    runtimeManager.getClient.mockReturnValue({ supportsImages: () => false });
    const sendAcpMessageSpy = vi
      .spyOn(service, 'sendAcpMessage')
      .mockResolvedValue('end_turn' as never);

    await service.sendSessionMessage('session-1', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
    ] as never);

    expect(sendAcpMessageSpy).toHaveBeenCalledWith(
      'session-1',
      [{ type: 'text', text: '[Image: not supported by this provider]' }],
      14_400_000
    );
  });

  it('uses the four-hour deadline for normal user messages', async () => {
    const { service, runtimeManager } = createPromptService();
    runtimeManager.getClient.mockReturnValue({ supportsImages: () => true });
    runtimeManager.sendPrompt.mockResolvedValue({ stopReason: 'end_turn' });

    await service.sendSessionMessage('session-1', 'continue');

    expect(runtimeManager.sendPrompt).toHaveBeenCalledWith(
      'session-1',
      [{ type: 'text', text: 'continue' }],
      14_400_000
    );
  });

  it('records one durable timeout event for the active attempt', async () => {
    const { service, runtimeManager, lifecycleEventService } = createPromptService();
    runtimeManager.getClient.mockReturnValue({ supportsImages: () => true });
    runtimeManager.sendPrompt.mockRejectedValue(new PromptTimeoutError('session-1', 14_400_000));

    await expect(service.sendSessionMessage('session-1', 'continue')).rejects.toThrow();

    expect(lifecycleEventService.record).toHaveBeenCalledOnce();
    expect(lifecycleEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        kind: 'TURN_INTERRUPTED',
        reason: 'PROMPT_TIMEOUT',
        message: 'Turn stopped: reached the 4-hour limit.',
        dedupeKey: expect.stringMatching(/^turn:.+:stop$/),
      })
    );
  });

  it('preserves a useful HTTP 529 overload reason', async () => {
    const { service, runtimeManager, lifecycleEventService } = createPromptService();
    runtimeManager.getClient.mockReturnValue({ supportsImages: () => true });
    runtimeManager.sendPrompt.mockRejectedValue(new Error('HTTP 529: Overloaded'));

    await expect(service.sendSessionMessage('session-1', 'continue')).rejects.toThrow();

    expect(lifecycleEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'PROVIDER_ERROR',
        message: 'Turn stopped: Codex returned HTTP 529 (Overloaded).',
      })
    );
  });

  it('does not record prompt cancellation after an explicit stop began', async () => {
    const { service, runtimeManager, lifecycleEventService, isSessionStopping } =
      createPromptService();
    isSessionStopping.mockReturnValue(true);
    runtimeManager.getClient.mockReturnValue({ supportsImages: () => true });
    runtimeManager.sendPrompt.mockRejectedValue(new Error('Prompt cancelled'));

    await expect(service.sendSessionMessage('session-1', 'continue')).rejects.toThrow();

    expect(lifecycleEventService.record).not.toHaveBeenCalled();
  });

  it('keeps one lifecycle transcript message when ACP reports an error before rejection', async () => {
    const runtimeManager = {
      getClient: vi.fn().mockReturnValue({ supportsImages: () => true }),
      isSessionWorking: vi.fn().mockReturnValue(true),
      sendPrompt: vi.fn(),
    };
    const sessionDomainService = new SessionDomainService();
    const lifecycleEvents = new Map<string, Record<string, unknown>>();
    const lifecycleStore = {
      upsert: vi.fn((input: { dedupeKey: string }) => {
        const existing = lifecycleEvents.get(input.dedupeKey);
        if (existing) {
          return existing;
        }
        const event = { ...input, id: 'event-1' };
        lifecycleEvents.set(input.dedupeKey, event);
        return event;
      }),
    };
    const lifecycleEventService = new SessionLifecycleEventService({
      store: lifecycleStore as never,
      sessionDomainService,
    });
    const acpEventProcessor = new AcpEventProcessor({
      runtimeManager: runtimeManager as never,
      sessionDomainService,
      sessionPermissionService: {
        createPermissionBridge: vi.fn(),
        handlePermissionRequest: vi.fn(),
      } as never,
      sessionConfigService: { applyConfigOptionsUpdateDelta: vi.fn() } as never,
      onToolCallTimeout: vi.fn(),
      lifecycleEventService,
    });
    acpEventProcessor.registerSessionContext('session-1', {
      workspaceId: 'workspace-1',
      workingDir: '/workspace',
      provider: 'CODEX',
    });
    const service = new SessionService({
      runtimeManager: runtimeManager as never,
      sessionDomainService,
      acpEventProcessor,
      promptTurnCompletionService: { schedule: vi.fn() } as never,
      lifecycleEventService,
      getStopGeneration: () => 0,
      isSessionStopping: () => false,
    });
    const prompt = createDeferred<{ stopReason: string }>();
    runtimeManager.sendPrompt.mockReturnValue(prompt.promise);

    const pending = service.sendSessionMessage('session-1', 'continue');
    await vi.waitFor(() => expect(runtimeManager.sendPrompt).toHaveBeenCalledOnce());
    acpEventProcessor.handleAcpDelta('session-1', {
      type: 'agent_message',
      data: { type: 'error', error: 'HTTP 529: Overloaded' },
    });
    prompt.reject(new Error('HTTP 529: Overloaded'));

    await expect(pending).rejects.toThrow('HTTP 529: Overloaded');
    await vi.waitFor(() => {
      expect(
        sessionDomainService
          .getTranscriptSnapshot('session-1')
          .filter((entry) => entry.message?.type === 'session_lifecycle')
      ).toHaveLength(1);
    });
    expect(lifecycleStore.upsert).toHaveBeenCalledTimes(2);
    expect(lifecycleStore.upsert.mock.calls[0]?.[0].dedupeKey).toBe(
      lifecycleStore.upsert.mock.calls[1]?.[0].dedupeKey
    );
  });

  it('serializes concurrent ACP prompts for the same session', async () => {
    const { service, runtimeManager } = createPromptService();
    const firstPrompt = createDeferred<{ stopReason: string }>();
    const secondPrompt = createDeferred<{ stopReason: string }>();
    runtimeManager.sendPrompt
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockImplementationOnce(() => secondPrompt.promise);

    const first = service.sendAcpMessage('session-1', [{ type: 'text', text: 'first' }]);
    await Promise.resolve();
    const second = service.sendAcpMessage('session-1', [{ type: 'text', text: 'second' }]);
    await Promise.resolve();

    expect(runtimeManager.sendPrompt).toHaveBeenCalledTimes(1);

    firstPrompt.resolve({ stopReason: 'end_turn' });
    await expect(first).resolves.toBe('end_turn');
    await vi.waitFor(() => {
      expect(runtimeManager.sendPrompt).toHaveBeenCalledTimes(2);
    });

    secondPrompt.resolve({ stopReason: 'end_turn' });
    await expect(second).resolves.toBe('end_turn');
  });

  it('does not serialize ACP prompts across sessions', async () => {
    const { service, runtimeManager } = createPromptService();
    const firstPrompt = createDeferred<{ stopReason: string }>();
    const secondPrompt = createDeferred<{ stopReason: string }>();
    runtimeManager.sendPrompt
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockImplementationOnce(() => secondPrompt.promise);

    const first = service.sendAcpMessage('session-1', [{ type: 'text', text: 'first' }]);
    const second = service.sendAcpMessage('session-2', [{ type: 'text', text: 'second' }]);
    await Promise.resolve();

    expect(runtimeManager.sendPrompt).toHaveBeenCalledTimes(2);

    firstPrompt.resolve({ stopReason: 'end_turn' });
    secondPrompt.resolve({ stopReason: 'end_turn' });
    await expect(Promise.all([first, second])).resolves.toEqual(['end_turn', 'end_turn']);
  });

  it('continues a session prompt queue after a prompt fails', async () => {
    const { service, runtimeManager } = createPromptService();
    const firstPrompt = createDeferred<{ stopReason: string }>();
    const secondPrompt = createDeferred<{ stopReason: string }>();
    runtimeManager.sendPrompt
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockImplementationOnce(() => secondPrompt.promise);

    const first = service.sendAcpMessage('session-1', [{ type: 'text', text: 'first' }]);
    const second = service.sendAcpMessage('session-1', [{ type: 'text', text: 'second' }]);

    firstPrompt.reject(new Error('prompt failed'));
    await expect(first).rejects.toThrow('prompt failed');
    await vi.waitFor(() => {
      expect(runtimeManager.sendPrompt).toHaveBeenCalledTimes(2);
    });

    secondPrompt.resolve({ stopReason: 'end_turn' });
    await expect(second).resolves.toBe('end_turn');
  });
});
