import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createManagerTestHarness,
  mockNewSession,
  mockLoadSession,
  mockPrompt,
  mockSetSessionConfigOption,
  setupSuccessfulSpawn,
} from './acp-runtime-manager.test-harness';
import {
  defaultConfigOptions,
  defaultContext,
  defaultHandlers,
  defaultOptions,
} from './acp-runtime-manager.test-helpers';

describe('saved startup model versus native ACP default', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { requestedModel: undefined, expectedModel: 'opus', label: 'native default control' },
    { requestedModel: 'sonnet', expectedModel: 'sonnet', label: 'saved Sonnet selection' },
  ])(
    'uses $expectedModel for the first prompt: $label',
    async ({ requestedModel, expectedModel }) => {
      const { manager } = createManagerTestHarness();
      setupSuccessfulSpawn();
      let providerModel = 'opus';
      const promptModels: string[] = [];
      const configOptions = () =>
        defaultConfigOptions().map((option) =>
          option.category === 'model' ? { ...option, currentValue: providerModel } : option
        );
      mockNewSession.mockImplementation(async () => ({
        sessionId: 'provider-session-123',
        configOptions: configOptions(),
      }));
      mockSetSessionConfigOption.mockImplementation(
        (request: { configId: string; value: string }) => {
          if (request.configId === 'model') {
            providerModel = request.value;
          }
          return { configOptions: configOptions() };
        }
      );
      mockPrompt.mockImplementation(() => {
        promptModels.push(providerModel);
        return { stopReason: 'end_turn' };
      });

      const handle = await manager.getOrCreateClient(
        'session-1',
        { ...defaultOptions(), model: requestedModel },
        defaultHandlers(),
        defaultContext()
      );
      await manager.sendPrompt('session-1', [{ type: 'text', text: 'First user prompt' }]);

      expect(promptModels).toEqual([expectedModel]);
      expect(handle.configOptions.find((option) => option.category === 'model')?.currentValue).toBe(
        expectedModel
      );
    }
  );

  it('restores a saved model on a resumed provider conversation before prompting', async () => {
    const { manager } = createManagerTestHarness();
    setupSuccessfulSpawn({ loadSession: true });
    let model = 'opus';
    const options = () =>
      defaultConfigOptions().map((option) =>
        option.id === 'model' ? { ...option, currentValue: model } : option
      );
    mockLoadSession.mockImplementation(async () => ({ configOptions: options() }));
    mockSetSessionConfigOption.mockImplementation((request: { value: string }) => {
      model = request.value;
      return { configOptions: options() };
    });
    mockPrompt.mockImplementation(() => {
      expect(model).toBe('sonnet');
      return { stopReason: 'end_turn' };
    });
    await manager.getOrCreateClient(
      'session-1',
      { ...defaultOptions(), model: 'sonnet', resumeProviderSessionId: 'existing' },
      defaultHandlers(),
      defaultContext()
    );
    await manager.sendPrompt('session-1', [{ type: 'text', text: 'Continue' }]);
    expect(mockNewSession).not.toHaveBeenCalled();
  });

  it('rejects an unavailable saved model without making a prompt available', async () => {
    const { manager } = createManagerTestHarness();
    const child = setupSuccessfulSpawn();
    child.kill.mockImplementation(() => {
      child.emit('exit', 0);
      return true;
    });
    await expect(
      manager.getOrCreateClient(
        'session-1',
        { ...defaultOptions(), model: 'unavailable' },
        defaultHandlers(),
        defaultContext()
      )
    ).rejects.toThrow('Unsupported model');
    expect(manager.getClient('session-1')).toBeUndefined();
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it('does not change a saved model while browsing a provider conversation', async () => {
    const { manager } = createManagerTestHarness();
    setupSuccessfulSpawn({ loadSession: true });
    await manager.getOrCreateClient(
      'session-1',
      {
        ...defaultOptions(),
        model: 'opus',
        purpose: 'browse',
        resumeProviderSessionId: 'existing',
      },
      defaultHandlers(),
      defaultContext()
    );
    expect(mockSetSessionConfigOption).not.toHaveBeenCalled();
  });

  it('fails and cleans up a stalled initial model configuration at the startup deadline', async () => {
    vi.useFakeTimers();
    const { manager } = createManagerTestHarness();
    manager.setAcpStartupTimeoutMs(25);
    const child = setupSuccessfulSpawn();
    child.kill.mockImplementation(() => {
      child.emit('exit', 0);
      return true;
    });
    mockSetSessionConfigOption.mockReturnValue(
      new Promise(() => {
        /* Simulate an adapter that never confirms its model. */
      })
    );
    let failure: unknown;
    const creation = manager
      .getOrCreateClient(
        'session-1',
        { ...defaultOptions(), model: 'opus' },
        defaultHandlers(),
        defaultContext()
      )
      .catch((error: unknown) => {
        failure = error;
      });
    try {
      await vi.advanceTimersByTimeAsync(30);
      expect(failure).toBeInstanceOf(Error);
      expect(failure instanceof Error ? failure.message : '').toContain(
        'model configuration timed out'
      );
      expect(manager.getClient('session-1')).toBeUndefined();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      await manager.stopClient('session-1');
      await creation;
      vi.useRealTimers();
    }
  });

  it('does not install a candidate stopped during model configuration', async () => {
    const { manager } = createManagerTestHarness();
    const child = setupSuccessfulSpawn();
    child.kill.mockImplementation(() => {
      child.emit('exit', 0);
      return true;
    });
    mockSetSessionConfigOption.mockReturnValue(
      new Promise(() => {
        /* Simulate an adapter that never confirms its model. */
      })
    );
    const creation = manager
      .getOrCreateClient(
        'session-1',
        { ...defaultOptions(), model: 'opus' },
        defaultHandlers(),
        defaultContext()
      )
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(mockSetSessionConfigOption).toHaveBeenCalled());
    await manager.stopClient('session-1');
    expect(await creation).toBeInstanceOf(Error);
    expect(manager.getClient('session-1')).toBeUndefined();
    expect(mockPrompt).not.toHaveBeenCalled();
  });
});
