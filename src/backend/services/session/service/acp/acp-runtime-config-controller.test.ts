import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpRuntimeConfigController } from './acp-runtime-config-controller';
import { createTestProcessHandle, defaultConfigOptions } from './acp-runtime-manager.test-helpers';

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    warn: mocks.warn,
  }),
}));

function configOptions(): SessionConfigOption[] {
  return [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      category: 'model',
      currentValue: 'sonnet',
      options: [
        { value: 'sonnet', name: 'Sonnet' },
        { value: 'opus', name: 'Opus' },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      category: 'mode',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan' },
      ],
    },
  ];
}

describe('AcpRuntimeConfigController', () => {
  let controller: AcpRuntimeConfigController;

  beforeEach(() => {
    controller = new AcpRuntimeConfigController();
    mocks.warn.mockReset();
  });

  it('updates a handle cache from a generic config response', async () => {
    const nextOptions = configOptions().map((option) =>
      option.id === 'mode' ? { ...option, currentValue: 'plan' } : option
    );
    const setSessionConfigOption = vi.fn().mockResolvedValue({ configOptions: nextOptions });
    const handle = createTestProcessHandle({
      provider: 'CODEX',
      connection: { setSessionConfigOption },
    });
    handle.configOptions = configOptions();

    await expect(controller.setConfigOption(handle, 'thought_level', 'high')).resolves.toEqual(
      nextOptions
    );
    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: handle.providerSessionId,
      configId: 'thought_level',
      value: 'high',
    });
    expect(handle.configOptions).toEqual(nextOptions);
  });

  it('replaces only the cached mode value after setSessionMode succeeds', async () => {
    const setSessionMode = vi.fn().mockResolvedValue({});
    const handle = createTestProcessHandle({
      connection: { setSessionMode },
    });
    handle.configOptions = configOptions();

    await expect(controller.setSessionMode(handle, 'plan')).resolves.toEqual([
      configOptions()[0],
      { ...configOptions()[1], currentValue: 'plan' },
    ]);
    expect(setSessionMode).toHaveBeenCalledWith({
      sessionId: handle.providerSessionId,
      modeId: 'plan',
    });
    expect(handle.configOptions.find((option) => option.category === 'mode')?.currentValue).toBe(
      'plan'
    );
  });

  it('uses Claude unstable_setSessionModel and replaces the cached model value', async () => {
    const unstableSetSessionModel = vi.fn().mockResolvedValue({});
    const handle = createTestProcessHandle({
      provider: 'CLAUDE',
      connection: { unstable_setSessionModel: unstableSetSessionModel },
    });
    handle.configOptions = configOptions();

    await expect(controller.setSessionModel(handle, 'opus')).resolves.toEqual([
      { ...configOptions()[0], currentValue: 'opus' },
      configOptions()[1],
    ]);
    expect(unstableSetSessionModel).toHaveBeenCalledWith({
      sessionId: handle.providerSessionId,
      modelId: 'opus',
    });
  });

  it('falls back to generic model configuration when Claude unstable model is unavailable', async () => {
    const unstableSetSessionModel = vi
      .fn()
      .mockRejectedValue({ code: -32_601, message: 'Method not found' });
    const setSessionConfigOption = vi.fn().mockResolvedValue({
      configOptions: configOptions().map((option) =>
        option.id === 'model' ? { ...option, currentValue: 'opus' } : option
      ),
    });
    const handle = createTestProcessHandle({
      provider: 'CLAUDE',
      connection: { unstable_setSessionModel: unstableSetSessionModel, setSessionConfigOption },
    });
    handle.configOptions = configOptions();

    await controller.setSessionModel(handle, 'opus');

    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: handle.providerSessionId,
      configId: 'model',
      value: 'opus',
    });
    expect(handle.configOptions.find((option) => option.category === 'model')?.currentValue).toBe(
      'opus'
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      'unstable_setSessionModel unavailable, falling back to setSessionConfigOption',
      expect.objectContaining({ provider: 'CLAUDE', modelId: 'opus' })
    );
  });

  it('propagates a Claude model error that is not method-not-found', async () => {
    const error = new Error('Model rejected');
    const unstableSetSessionModel = vi.fn().mockRejectedValue(error);
    const handle = createTestProcessHandle({
      provider: 'CLAUDE',
      connection: { unstable_setSessionModel: unstableSetSessionModel },
    });
    handle.configOptions = configOptions();

    await expect(controller.setSessionModel(handle, 'opus')).rejects.toBe(error);
    expect(mocks.warn).toHaveBeenCalledWith(
      'setSessionModel failed',
      expect.objectContaining({ provider: 'CLAUDE', modelId: 'opus', error: 'Model rejected' })
    );
  });

  it('uses generic model configuration for Codex', async () => {
    const setSessionConfigOption = vi.fn().mockResolvedValue({
      configOptions: configOptions().map((option) =>
        option.id === 'model' ? { ...option, currentValue: 'gpt-5.2-codex' } : option
      ),
    });
    const unstableSetSessionModel = vi.fn();
    const handle = createTestProcessHandle({
      provider: 'CODEX',
      connection: { setSessionConfigOption, unstable_setSessionModel: unstableSetSessionModel },
    });
    handle.configOptions = configOptions();

    await controller.setSessionModel(handle, 'gpt-5.2-codex');

    expect(unstableSetSessionModel).not.toHaveBeenCalled();
    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: handle.providerSessionId,
      configId: 'model',
      value: 'gpt-5.2-codex',
    });
  });

  it('rejects a generic response missing required config categories', async () => {
    const setSessionConfigOption = vi.fn().mockResolvedValue({
      configOptions: [
        {
          id: 'reasoning_effort',
          name: 'Reasoning Effort',
          type: 'select',
          category: 'thought_level',
          currentValue: 'medium',
          options: [{ value: 'medium', name: 'Medium' }],
        },
      ],
    });
    const handle = createTestProcessHandle({ connection: { setSessionConfigOption } });
    handle.configOptions = configOptions();

    await expect(controller.setConfigOption(handle, 'mode', 'plan')).rejects.toThrow(
      'missing required config option categories: model, mode'
    );
    expect(handle.configOptions).toEqual(configOptions());
  });

  it('warns and rethrows generic and mode operation failures', async () => {
    const configError = new Error('Config rejected');
    const setSessionConfigOption = vi.fn().mockRejectedValue(configError);
    const handle = createTestProcessHandle({ connection: { setSessionConfigOption } });
    handle.configOptions = defaultConfigOptions();

    await expect(controller.setConfigOption(handle, 'mode', 'plan')).rejects.toBe(configError);
    expect(mocks.warn).toHaveBeenCalledWith(
      'setSessionConfigOption failed',
      expect.objectContaining({
        configId: 'mode',
        provider: handle.provider,
        error: 'Config rejected',
      })
    );

    const modeError = new Error('Mode rejected');
    const setSessionMode = vi.fn().mockRejectedValue(modeError);
    const modeHandle = createTestProcessHandle({ connection: { setSessionMode } });
    modeHandle.configOptions = configOptions();

    await expect(controller.setSessionMode(modeHandle, 'plan')).rejects.toBe(modeError);
    expect(mocks.warn).toHaveBeenCalledWith(
      'setSessionMode failed',
      expect.objectContaining({ modeId: 'plan', error: 'Mode rejected' })
    );
  });
});
