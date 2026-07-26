import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionService } from './session.service';

function createPromptService() {
  const runtimeManager = {
    getClient: vi.fn(),
    sendPrompt: vi.fn(),
  };
  const sessionDomainService = {
    setRuntimeSnapshot: vi.fn(),
  };
  const acpEventProcessor = {
    getWorkspaceId: vi.fn(),
    beginPromptTurn: vi.fn(),
    finishPromptTurn: vi.fn(),
    finalizeOrphanedToolCalls: vi.fn(),
  };
  const promptTurnCompletionService = {
    schedule: vi.fn(),
  };
  const service = new SessionService({
    runtimeManager: runtimeManager as never,
    sessionDomainService: sessionDomainService as never,
    acpEventProcessor: acpEventProcessor as never,
    promptTurnCompletionService: promptTurnCompletionService as never,
    getStopGeneration: () => 0,
    isSessionStopping: () => false,
  });

  return {
    service,
    runtimeManager,
    sessionDomainService,
    acpEventProcessor,
    promptTurnCompletionService,
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
      3_600_000
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
      3_600_000
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
