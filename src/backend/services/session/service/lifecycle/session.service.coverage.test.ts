import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionService } from './session.service';

function createServiceWithPatchedInternals() {
  const runtimeManager = {
    getClient: vi.fn(),
    sendPrompt: vi.fn(),
    cancelPrompt: vi.fn(),
    isSessionRunning: vi.fn(),
    isSessionWorking: vi.fn(),
    isAnySessionWorking: vi.fn(),
  };

  const sessionDomainService = {
    setRuntimeSnapshot: vi.fn(),
    getTranscriptSnapshot: vi.fn(),
  };

  const service = createSessionService({
    runtimeManager: runtimeManager as never,
    sessionDomainService: sessionDomainService as never,
    repository: {} as never,
  });

  const lifecycleService = {
    stopWorkspaceSessions: vi.fn(async () => undefined),
    getOrCreateSessionClient: vi.fn(async () => ({ id: 'client' })),
    getOrCreateSessionClientFromRecord: vi.fn(async () => ({ id: 'client-from-record' })),
    getSessionClient: vi.fn(() => ({ id: 'existing-client' })),
    getRuntimeSnapshot: vi.fn(() => ({ phase: 'idle' })),
    getSessionOptions: vi.fn(async () => ({ workingDir: '/tmp', model: 'gpt-5' })),
    stopAllClients: vi.fn(async () => undefined),
  };

  const sessionConfigService = {
    getSessionConfigOptions: vi.fn(() => [{ id: 'mode' }]),
    getSessionConfigOptionsWithFallback: vi.fn(async () => [{ id: 'model' }]),
    setSessionModel: vi.fn(async () => undefined),
    setSessionThinkingBudget: vi.fn(async () => undefined),
    setSessionConfigOption: vi.fn(async () => undefined),
    getChatBarCapabilities: vi.fn(async () => ({ provider: 'CODEX' })),
  };

  const sessionPermissionService = {
    respondToPermission: vi.fn(() => true),
  };

  (service as unknown as { lifecycleService: unknown }).lifecycleService = lifecycleService;
  (service as unknown as { sessionConfigService: unknown }).sessionConfigService =
    sessionConfigService;
  (service as unknown as { sessionPermissionService: unknown }).sessionPermissionService =
    sessionPermissionService;
  (service as unknown as { runtimeManager: unknown }).runtimeManager = runtimeManager;
  (service as unknown as { sessionDomainService: unknown }).sessionDomainService =
    sessionDomainService;

  return {
    service,
    lifecycleService,
    sessionConfigService,
    sessionPermissionService,
    runtimeManager,
    sessionDomainService,
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

describe('SessionService coverage wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates lifecycle/config/permission wrappers', async () => {
    const {
      service,
      lifecycleService,
      sessionConfigService,
      sessionPermissionService,
      runtimeManager,
    } = createServiceWithPatchedInternals();

    await service.stopWorkspaceSessions('workspace-1');
    await service.getOrCreateSessionClient('session-1', { model: 'gpt-5' });
    await service.getOrCreateSessionClientFromRecord({ id: 'session-2' } as never, {
      model: 'gpt-5-mini',
    });
    service.getSessionClient('session-1');
    service.getSessionConfigOptions('session-1');
    await service.getSessionConfigOptionsWithFallback('session-1');
    await service.setSessionModel('session-1', 'gpt-5');
    await service.setSessionThinkingBudget('session-1', 16_000);
    await service.setSessionConfigOption('session-1', 'mode', 'plan');
    service.respondToAcpPermission('session-1', 'req-1', 'allow_once', { mode: ['default'] });
    service.getRuntimeSnapshot('session-1');
    await service.getSessionOptions('session-1');
    await service.getChatBarCapabilities('session-1');
    await service.stopAllClients(2500);
    service.isSessionRunning('session-1');
    service.isSessionWorking('session-1');
    service.isAnySessionWorking(['session-1']);

    expect(lifecycleService.stopWorkspaceSessions).toHaveBeenCalledWith('workspace-1');
    expect(lifecycleService.getOrCreateSessionClient).toHaveBeenCalledWith('session-1', {
      model: 'gpt-5',
    });
    expect(lifecycleService.getOrCreateSessionClientFromRecord).toHaveBeenCalled();
    expect(lifecycleService.getSessionClient).toHaveBeenCalledWith('session-1');
    expect(sessionConfigService.getSessionConfigOptions).toHaveBeenCalledWith('session-1');
    expect(sessionConfigService.getSessionConfigOptionsWithFallback).toHaveBeenCalledWith(
      'session-1'
    );
    expect(sessionConfigService.setSessionModel).toHaveBeenCalledWith('session-1', 'gpt-5');
    expect(sessionConfigService.setSessionThinkingBudget).toHaveBeenCalledWith('session-1', 16_000);
    expect(sessionConfigService.setSessionConfigOption).toHaveBeenCalledWith(
      'session-1',
      'mode',
      'plan'
    );
    expect(sessionPermissionService.respondToPermission).toHaveBeenCalledWith(
      'session-1',
      'req-1',
      'allow_once',
      { mode: ['default'] }
    );
    expect(lifecycleService.getRuntimeSnapshot).toHaveBeenCalledWith('session-1');
    expect(lifecycleService.getSessionOptions).toHaveBeenCalledWith('session-1');
    expect(sessionConfigService.getChatBarCapabilities).toHaveBeenCalledWith('session-1');
    expect(lifecycleService.stopAllClients).toHaveBeenCalledWith(2500);
    expect(runtimeManager.isSessionRunning).toHaveBeenCalledWith('session-1');
    expect(runtimeManager.isSessionWorking).toHaveBeenCalledWith('session-1');
    expect(runtimeManager.isAnySessionWorking).toHaveBeenCalledWith(['session-1']);
  });

  it('rejects when sendSessionMessage is called without an ACP client', async () => {
    const { service, runtimeManager } = createServiceWithPatchedInternals();
    runtimeManager.getClient.mockReturnValue(undefined);
    const sendAcpMessageSpy = vi.spyOn(service, 'sendAcpMessage');

    await expect(service.sendSessionMessage('session-1', 'hello')).rejects.toThrow(
      'No ACP client found for sendSessionMessage: session-1'
    );
    expect(sendAcpMessageSpy).not.toHaveBeenCalled();
  });

  it('converts content blocks to ACP ContentBlock[] with image support', async () => {
    const { service, runtimeManager } = createServiceWithPatchedInternals();
    runtimeManager.getClient.mockReturnValue({ id: 'client', supportsImages: () => true });
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
      3_600_000
    );
  });

  it('falls back to text placeholder for images when provider lacks support', async () => {
    const { service, runtimeManager } = createServiceWithPatchedInternals();
    runtimeManager.getClient.mockReturnValue({ id: 'client', supportsImages: () => false });
    const sendAcpMessageSpy = vi
      .spyOn(service, 'sendAcpMessage')
      .mockResolvedValue('end_turn' as never);

    await service.sendSessionMessage('session-1', [
      { type: 'text', text: 'hello' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
    ] as never);

    expect(sendAcpMessageSpy).toHaveBeenCalledWith(
      'session-1',
      [
        { type: 'text', text: 'hello' },
        { type: 'text', text: '[Image: not supported by this provider]' },
      ],
      3_600_000
    );
  });

  it('propagates sendAcpMessage errors', async () => {
    const { service, runtimeManager } = createServiceWithPatchedInternals();
    runtimeManager.getClient.mockReturnValue({ id: 'client', supportsImages: () => false });
    vi.spyOn(service, 'sendAcpMessage').mockRejectedValue(new Error('prompt failed'));

    await expect(service.sendSessionMessage('session-1', 'hello')).rejects.toThrow('prompt failed');
  });

  it('serializes concurrent ACP prompts for the same session', async () => {
    const { service, runtimeManager } = createServiceWithPatchedInternals();
    const firstPrompt = createDeferred<{ stopReason: string }>();
    const secondPrompt = createDeferred<{ stopReason: string }>();
    runtimeManager.sendPrompt
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockImplementationOnce(() => secondPrompt.promise);

    const p1 = service.sendAcpMessage('session-1', [{ type: 'text', text: 'first' }]);
    await Promise.resolve();
    expect(runtimeManager.sendPrompt).toHaveBeenCalledTimes(1);

    const p2 = service.sendAcpMessage('session-1', [{ type: 'text', text: 'second' }]);
    await Promise.resolve();
    expect(runtimeManager.sendPrompt).toHaveBeenCalledTimes(1);

    firstPrompt.resolve({ stopReason: 'end_turn' });
    await expect(p1).resolves.toBe('end_turn');
    await Promise.resolve();

    expect(runtimeManager.sendPrompt).toHaveBeenCalledTimes(2);
    expect(runtimeManager.sendPrompt).toHaveBeenNthCalledWith(
      2,
      'session-1',
      [{ type: 'text', text: 'second' }],
      undefined
    );

    secondPrompt.resolve({ stopReason: 'end_turn' });
    await expect(p2).resolves.toBe('end_turn');
  });

  it('does not serialize ACP prompts across different sessions', async () => {
    const { service, runtimeManager } = createServiceWithPatchedInternals();
    const firstPrompt = createDeferred<{ stopReason: string }>();
    const secondPrompt = createDeferred<{ stopReason: string }>();
    runtimeManager.sendPrompt
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockImplementationOnce(() => secondPrompt.promise);

    const p1 = service.sendAcpMessage('session-1', [{ type: 'text', text: 'first' }]);
    const p2 = service.sendAcpMessage('session-2', [{ type: 'text', text: 'second' }]);
    await Promise.resolve();

    expect(runtimeManager.sendPrompt).toHaveBeenCalledTimes(2);

    firstPrompt.resolve({ stopReason: 'end_turn' });
    secondPrompt.resolve({ stopReason: 'end_turn' });
    await expect(Promise.all([p1, p2])).resolves.toEqual(['end_turn', 'end_turn']);
  });

  it('continues same-session ACP prompt queue after a prompt fails', async () => {
    const { service, runtimeManager } = createServiceWithPatchedInternals();
    const firstPrompt = createDeferred<{ stopReason: string }>();
    const secondPrompt = createDeferred<{ stopReason: string }>();
    runtimeManager.sendPrompt
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockImplementationOnce(() => secondPrompt.promise);

    const p1 = service.sendAcpMessage('session-1', [{ type: 'text', text: 'first' }]);
    const p2 = service.sendAcpMessage('session-1', [{ type: 'text', text: 'second' }]);
    await Promise.resolve();
    expect(runtimeManager.sendPrompt).toHaveBeenCalledTimes(1);

    firstPrompt.reject(new Error('prompt failed'));
    await expect(p1).rejects.toThrow('prompt failed');
    await Promise.resolve();

    expect(runtimeManager.sendPrompt).toHaveBeenCalledTimes(2);

    secondPrompt.resolve({ stopReason: 'end_turn' });
    await expect(p2).resolves.toBe('end_turn');
  });

  it('maps transcript entries into conversation history', () => {
    const { service, sessionDomainService } = createServiceWithPatchedInternals();
    sessionDomainService.getTranscriptSnapshot.mockReturnValue([
      {
        source: 'user',
        text: 'plain user text',
        timestamp: '2026-02-27T00:00:00.000Z',
      },
      {
        source: 'assistant',
        timestamp: '2026-02-27T00:01:00.000Z',
        message: {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'chunk one' },
              { type: 'image', mimeType: 'image/png', data: 'abc' },
              { type: 'text', text: 'chunk two' },
            ],
          },
        },
      },
      {
        source: 'assistant',
        timestamp: '2026-02-27T00:02:00.000Z',
        message: {
          type: 'assistant',
          message: {
            content: 'single assistant string',
          },
        },
      },
      {
        source: 'assistant',
        timestamp: '2026-02-27T00:03:00.000Z',
        message: { type: 'tool' },
      },
    ]);

    expect(service.getSessionConversationHistory('session-1', '/tmp/work')).toEqual([
      {
        type: 'user',
        content: 'plain user text',
        timestamp: '2026-02-27T00:00:00.000Z',
      },
      {
        type: 'assistant',
        content: 'chunk one\nchunk two',
        timestamp: '2026-02-27T00:01:00.000Z',
      },
      {
        type: 'assistant',
        content: 'single assistant string',
        timestamp: '2026-02-27T00:02:00.000Z',
      },
    ]);
  });
});
