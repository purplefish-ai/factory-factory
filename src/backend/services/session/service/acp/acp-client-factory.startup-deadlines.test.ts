import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AcpClientFactory,
  CONFIG_OPTIONS,
  createDeferred,
  createMockChildProcess,
  createParams,
  createSignal,
  defaultOptions,
  mocks,
  resetAcpClientFactoryMocks,
  setupSuccessfulSpawn,
} from '@/backend/services/session/service/acp/acp-client-factory.test-harness';

describe('AcpClientFactory startup deadlines', () => {
  beforeEach(resetAcpClientFactoryMocks);

  it('times out startup and terminates the child', async () => {
    const child = setupSuccessfulSpawn(createMockChildProcess({ exitAfterSigterm: true }));
    mocks.initialize.mockReturnValue(new Promise(() => undefined));

    await expect(
      new AcpClientFactory({ acpStartupTimeoutMs: 10 }).createClient(createParams())
    ).rejects.toThrow('ACP initialize handshake timed out after 10ms');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('gives session creation its own deadline, longer than the initialize handshake', async () => {
    vi.useFakeTimers();
    try {
      const child = setupSuccessfulSpawn(createMockChildProcess({ exitAfterSigterm: true }));
      mocks.newSession.mockReturnValue(new Promise(() => undefined));
      const creation = new AcpClientFactory({
        acpStartupTimeoutMs: 10,
        acpSessionCreationTimeoutMs: 50,
      }).createClient(createParams());
      let settled = false;
      const result = creation.then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error })
      );
      void result.finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.newSession).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const { error } = await result;
      expect(error).toEqual(new Error('ACP session creation timed out after 50ms'));
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the session creation deadline to startup model configuration', async () => {
    vi.useFakeTimers();
    try {
      setupSuccessfulSpawn(createMockChildProcess({ exitAfterSigterm: true }));
      mocks.newSession.mockResolvedValue({
        sessionId: 'native',
        configOptions: CONFIG_OPTIONS.map((option) =>
          option.id === 'model' ? { ...option, currentValue: 'other' } : option
        ),
      });
      mocks.setSessionConfigOption.mockReturnValue(new Promise(() => undefined));
      const creation = new AcpClientFactory({
        acpStartupTimeoutMs: 10,
        acpSessionCreationTimeoutMs: 50,
      }).createClient(createParams({ options: defaultOptions({ model: 'sonnet' }) }));
      let settled = false;
      const result = creation.then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error })
      );
      void result.finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.setSessionConfigOption).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const { error } = await result;
      expect(error).toEqual(new Error('ACP model configuration timed out after 50ms'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the creation timeout snapshot when configuration changes during initialize', async () => {
    vi.useFakeTimers();
    try {
      setupSuccessfulSpawn(createMockChildProcess({ exitAfterSigterm: true }));
      const initialize = createDeferred<{
        protocolVersion: number;
        agentCapabilities: Record<string, unknown>;
      }>();
      const newSession = createDeferred<{
        sessionId: string;
        configOptions: typeof CONFIG_OPTIONS;
      }>();
      mocks.initialize.mockReturnValue(initialize.promise);
      mocks.newSession.mockReturnValue(newSession.promise);
      const factory = new AcpClientFactory({
        acpStartupTimeoutMs: 100,
        acpSessionCreationTimeoutMs: 100,
      });
      const creation = factory.createClient(createParams());
      const result = creation.then(
        (handle) => ({ handle }),
        (error: unknown) => ({ error })
      );
      await vi.advanceTimersByTimeAsync(0);

      factory.setAcpStartupTimeoutMs(10);
      factory.setAcpSessionCreationTimeoutMs(10);
      initialize.resolve({ protocolVersion: 1, agentCapabilities: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.newSession).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10);
      newSession.resolve({
        sessionId: 'provider-session-after-config-change',
        configOptions: CONFIG_OPTIONS,
      });
      await vi.advanceTimersByTimeAsync(0);

      await expect(result).resolves.toMatchObject({
        handle: { providerSessionId: 'provider-session-after-config-change' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['shutdown', 'stop'] as const)(
    'preserves %s cancellation classification and leaves signal disposal to the manager',
    async (kind) => {
      const child = setupSuccessfulSpawn(createMockChildProcess({ exitAfterSigterm: true }));
      mocks.initialize.mockReturnValue(new Promise(() => undefined));
      const shutdownSignal = createSignal();
      const stopSignal = createSignal();
      const selectedSignal = kind === 'shutdown' ? shutdownSignal : stopSignal;
      const expected = new Error(`${kind} cancellation`);
      const creation = new AcpClientFactory().createClient(
        createParams({ shutdownSignal, stopSignal })
      );
      await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalledTimes(1));

      selectedSignal.reject(expected);

      await expect(creation).rejects.toBe(expected);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(shutdownSignal.dispose).not.toHaveBeenCalled();
      expect(stopSignal.dispose).not.toHaveBeenCalled();
    }
  );
});
