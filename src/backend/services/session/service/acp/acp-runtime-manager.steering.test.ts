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
  exitChildAfterSigterm,
  type MockChildProcess,
} from './acp-runtime-manager.test-helpers';
import { AcpSteeringTimeoutError } from './acp-steering';

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
    handle.connection.close = vi.fn();
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
    expect(handle.connection.close).not.toHaveBeenCalled();
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

  it('refuses steering while the current runtime is stopping', async () => {
    const { manager, pending, prompt, handle } = await runningSession();
    const cancel = createDeferred<void>();
    mockCancel.mockReturnValue(cancel.promise);
    exitChildAfterSigterm(handle.child as unknown as MockChildProcess);
    const stopped = manager.stopClient('session');
    await expect(manager.steerSession('session', input)).rejects.toThrow('not ready for steering');
    expect(mockExtMethod).not.toHaveBeenCalled();
    cancel.resolve();
    await stopped;
    pending.resolve({ stopReason: 'end_turn' });
    await prompt;
  });

  it('refuses steering when the installed runtime has died', async () => {
    const { manager, pending, prompt, handle } = await runningSession();
    const child = handle.child as unknown as MockChildProcess;
    child.exitCode = 1;
    await expect(manager.steerSession('session', input)).rejects.toThrow('not ready for steering');
    expect(mockExtMethod).not.toHaveBeenCalled();
    pending.resolve({ stopReason: 'end_turn' });
    await prompt;
  });

  it('terminates a runtime with a hung steer before releasing input ownership', async () => {
    const { manager, pending, prompt, handle } = await runningSession();
    const extension = createDeferred<unknown>();
    mockExtMethod.mockReturnValue(extension.promise);
    const child = handle.child as unknown as MockChildProcess;
    let settled = false;
    vi.useFakeTimers();
    try {
      const steering = manager
        .steerSession('session', input)
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(settled).toBe(false);
      expect(mockCancel).not.toHaveBeenCalled();
      child.exitCode = 0;
      child.emit('exit', 0, null);
      await expect(steering).resolves.toMatchObject({
        name: 'AcpSteeringTimeoutError',
        message: expect.stringContaining('Steering acknowledgment timed out'),
      });
      expect(manager.getClient('session')).toBeUndefined();
      extension.resolve({ outcome: 'injected' });
      pending.resolve({ stopReason: 'end_turn' });
      await prompt;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    'transport close throws',
    'process signal returns false',
    'process signal throws',
  ] as const)('preserves timeout identity when cleanup fails: %s', async (failure) => {
    const { manager, pending, prompt, handle } = await runningSession();
    const extension = createDeferred<unknown>();
    mockExtMethod.mockReturnValue(extension.promise);
    const child = handle.child as unknown as MockChildProcess;
    const cleanupError = new Error('Cleanup unavailable');
    if (failure === 'transport close throws') {
      handle.connection.close = vi.fn(() => {
        throw cleanupError;
      });
      exitChildAfterSigterm(child);
    } else if (failure === 'process signal returns false') {
      child.kill = vi.fn(() => false);
    } else {
      child.kill = vi.fn(() => {
        throw cleanupError;
      });
    }
    vi.useFakeTimers();
    try {
      const steering = manager.steerSession('session', input).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      const error = await steering;
      expect(error).toBeInstanceOf(AcpSteeringTimeoutError);
      expect(error).toMatchObject({
        name: 'AcpSteeringTimeoutError',
        message: expect.stringContaining('cleanup reported an error'),
        cause: expect.any(Error),
      });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      extension.resolve({ outcome: 'injected' });
      pending.resolve({ stopReason: 'end_turn' });
      await prompt;
    } finally {
      vi.useRealTimers();
    }
  });

  it('unblocks an already pending stop when cancellation RPC also hangs', async () => {
    const { manager, pending, prompt, handle } = await runningSession();
    const extension = createDeferred<unknown>();
    const cancel = createDeferred<void>();
    mockExtMethod.mockReturnValue(extension.promise);
    mockCancel.mockReturnValue(cancel.promise);
    handle.connection.close = vi.fn(() => cancel.reject(new Error('Connection closed')));
    exitChildAfterSigterm(handle.child as unknown as MockChildProcess);
    vi.useFakeTimers();
    try {
      const steering = manager.steerSession('session', input).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(9000);
      const stop = manager.stopClient('session');
      await vi.advanceTimersByTimeAsync(1000);
      expect(handle.connection.close).toHaveBeenCalledOnce();
      await expect(steering).resolves.toMatchObject({ name: 'AcpSteeringTimeoutError' });
      await stop;
      expect(manager.getClient('session')).toBeUndefined();
      extension.resolve({ outcome: 'injected' });
      pending.resolve({ stopReason: 'end_turn' });
      await prompt;
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates a pending stop when transport close and cancellation both fail', async () => {
    const { manager, pending, prompt, handle } = await runningSession();
    const extension = createDeferred<unknown>();
    const cancel = createDeferred<void>();
    const closeError = new Error('Transport close failed');
    mockExtMethod.mockReturnValue(extension.promise);
    mockCancel.mockReturnValue(cancel.promise);
    handle.connection.close = vi.fn(() => {
      throw closeError;
    });
    const child = handle.child as unknown as MockChildProcess;
    exitChildAfterSigterm(child);
    let settled = false;
    vi.useFakeTimers();
    try {
      const steering = manager
        .steerSession('session', input)
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(9000);
      const stop = manager.stopClient('session');
      await vi.advanceTimersByTimeAsync(1000);
      expect(handle.connection.close).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(5000);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      const error = await steering;
      expect(error).toBeInstanceOf(AcpSteeringTimeoutError);
      expect(error).toMatchObject({ cause: closeError });
      await stop;
      expect(manager.getClient('session')).toBeUndefined();
      extension.resolve({ outcome: 'injected' });
      cancel.resolve();
      pending.resolve({ stopReason: 'end_turn' });
      await prompt;
    } finally {
      vi.useRealTimers();
    }
  });

  it('never stops a replacement runtime when an old steer times out', async () => {
    const { manager, pending, prompt, handle } = await runningSession();
    const extension = createDeferred<unknown>();
    mockExtMethod.mockReturnValue(extension.promise);
    vi.useFakeTimers();
    try {
      const steering = manager.steerSession('session', input).catch((error: unknown) => error);
      const child = handle.child as unknown as MockChildProcess;
      child.exitCode = 1;
      child.emit('exit', 1, null);
      await vi.waitFor(() => expect(manager.getClient('session')).toBeUndefined());
      const replacementChild = setupSuccessfulSpawn();
      const replacement = await manager.getOrCreateClient(
        'session',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );
      replacement.isPromptInFlight = true;
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(steering).resolves.toMatchObject({ name: 'AcpSteeringTimeoutError' });
      expect(manager.getClient('session')).toBe(replacement);
      expect(replacementChild.kill).not.toHaveBeenCalled();
      expect(replacement.isPromptInFlight).toBe(true);
      extension.resolve({ outcome: 'injected' });
      pending.resolve({ stopReason: 'end_turn' });
      await prompt;
    } finally {
      vi.useRealTimers();
    }
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
