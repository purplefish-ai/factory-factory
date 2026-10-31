import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createManagerTestHarness,
  mockCancel,
  mockExtMethod,
  mockInitialize,
  mockPrompt,
  mockSpawn,
  setupSuccessfulSpawn,
} from './acp-runtime-manager.test-harness';
import {
  createDeferred,
  defaultContext,
  defaultHandlers,
  defaultOptions,
} from './acp-runtime-manager.test-helpers';

const input = [{ type: 'text' as const, text: 'Focus on the failing test first.' }];

describe('ACP runtime steering', () => {
  beforeEach(() => vi.clearAllMocks());

  async function runningSession(supported = true) {
    const { manager } = createManagerTestHarness();
    setupSuccessfulSpawn();
    mockInitialize.mockResolvedValue({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { steering: { supported } },
    });
    const handle = await manager.getOrCreateClient(
      'session',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );
    const pending = createDeferred<{ stopReason: string }>();
    mockPrompt.mockReturnValue(pending.promise);
    const prompt = manager.sendPrompt('session', [{ type: 'text', text: 'Original task' }]);
    return { manager, handle, pending, prompt };
  }

  it('injects into the active prompt without cancelling or releasing its slot', async () => {
    const { manager, handle, pending, prompt } = await runningSession();
    mockExtMethod.mockResolvedValue({ outcome: 'injected' });

    await expect(manager.steerSession('session', input)).resolves.toEqual({ outcome: 'injected' });
    expect(mockExtMethod).toHaveBeenCalledWith('_session/steering', {
      sessionId: 'provider-session-123',
      prompt: input,
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    });
    expect(handle.supportsSteering).toBe(true);
    expect(handle.isPromptInFlight).toBe(true);
    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    pending.resolve({ stopReason: 'end_turn' });
    await prompt;
    expect(handle.isPromptInFlight).toBe(false);
  });

  it('returns input ownership when the provider turn completes before injection', async () => {
    const { manager, handle, pending, prompt } = await runningSession();
    mockExtMethod.mockResolvedValue({ outcome: 'promptRequired', reason: 'noRunningTurn' });
    await expect(manager.steerSession('session', input)).resolves.toEqual({
      outcome: 'promptRequired',
    });
    expect(handle.isPromptInFlight).toBe(true);
    pending.resolve({ stopReason: 'end_turn' });
    await prompt;
    mockExtMethod.mockClear();
    await expect(manager.steerSession('session', input)).resolves.toEqual({
      outcome: 'promptRequired',
    });
    expect(mockExtMethod).not.toHaveBeenCalled();
  });

  it('does not start a runtime when there is no active prompt', async () => {
    const { manager } = createManagerTestHarness();
    await expect(manager.steerSession('missing', input)).resolves.toEqual({
      outcome: 'promptRequired',
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects unsupported steering without affecting the original prompt', async () => {
    const { manager, pending, prompt, handle } = await runningSession(false);
    await expect(manager.steerSession('session', input)).rejects.toThrow(
      'does not support steering'
    );
    expect(mockExtMethod).not.toHaveBeenCalled();
    expect(handle.isPromptInFlight).toBe(true);
    pending.resolve({ stopReason: 'end_turn' });
    await prompt;
  });

  it.each([
    undefined,
    {},
    { outcome: 'startedNewTurn' },
    { outcome: 'failed' },
    { outcome: 'promptRequired' },
  ])('rejects invalid adapter responses without releasing the prompt: %j', async (response) => {
    const { manager, pending, prompt, handle } = await runningSession();
    mockExtMethod.mockResolvedValue(response);
    await expect(manager.steerSession('session', input)).rejects.toThrow();
    expect(handle.isPromptInFlight).toBe(true);
    pending.resolve({ stopReason: 'end_turn' });
    await prompt;
  });

  it('refuses steering while required configuration is incomplete', async () => {
    const { manager, pending, prompt, handle } = await runningSession();
    const lease = handle.beginConfiguration();
    await expect(manager.steerSession('session', input)).rejects.toThrow('not ready for steering');
    expect(mockExtMethod).not.toHaveBeenCalled();
    expect(handle.isPromptInFlight).toBe(true);
    lease.complete();
    pending.resolve({ stopReason: 'end_turn' });
    await prompt;
  });

  it('does not wait for configuration edits that are themselves waiting for this prompt', async () => {
    const { manager, pending, prompt, handle } = await runningSession();
    const edit = createDeferred<void>();
    handle.trackPendingConfigUpdate(edit.promise);
    mockExtMethod.mockResolvedValue({ outcome: 'injected' });
    await expect(manager.steerSession('session', input)).resolves.toEqual({ outcome: 'injected' });
    pending.resolve({ stopReason: 'end_turn' });
    await prompt;
    edit.resolve();
  });

  it('preserves the original prompt when the extension request fails', async () => {
    const { manager, pending, prompt, handle } = await runningSession();
    mockExtMethod.mockRejectedValue(new Error('provider disconnected'));
    await expect(manager.steerSession('session', input)).rejects.toThrow('provider disconnected');
    expect(handle.isPromptInFlight).toBe(true);
    pending.resolve({ stopReason: 'end_turn' });
    await prompt;
  });
});
