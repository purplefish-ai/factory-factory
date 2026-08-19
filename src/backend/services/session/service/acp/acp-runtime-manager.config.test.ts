import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AcpRuntimeManager,
  createManagerTestHarness,
  mockSetSessionConfigOption,
  mockSetSessionMode,
  mockSetSessionModel,
  setupSuccessfulSpawn,
} from './acp-runtime-manager.test-harness';
import {
  defaultContext,
  defaultHandlers,
  defaultOptions,
} from './acp-runtime-manager.test-helpers';

describe('AcpRuntimeManager', () => {
  let manager: AcpRuntimeManager;

  beforeEach(() => {
    ({ manager } = createManagerTestHarness());
  });

  describe('setConfigOption', () => {
    it.each([
      ['setConfigOption', () => manager.setConfigOption('missing-session', 'mode', 'plan')],
      ['setSessionMode', () => manager.setSessionMode('missing-session', 'plan')],
      ['setSessionModel', () => manager.setSessionModel('missing-session', 'opus')],
    ])('preserves the missing-session promise rejection for %s', async (_operation, call) => {
      await expect(call()).rejects.toThrow('No ACP session found for sessionId: missing-session');
    });

    it('updates cached config options from setSessionConfigOption response', async () => {
      setupSuccessfulSpawn();
      mockSetSessionConfigOption.mockResolvedValueOnce({
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            category: 'model',
            currentValue: 'opus',
            options: [
              { value: 'default', name: 'Default (recommended)', description: 'Opus 4.6 · best' },
              { value: 'opus', name: 'Opus' },
            ],
          },
          {
            id: 'mode',
            name: 'Mode',
            type: 'select',
            category: 'mode',
            currentValue: 'plan',
            options: [
              { value: 'default', name: 'Default' },
              { value: 'plan', name: 'Plan' },
            ],
          },
        ],
      });

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await manager.setConfigOption('session-1', 'mode', 'plan');

      const defaultModelOption = handle.configOptions
        .find((option) => option.id === 'model')
        ?.options.find((option) => 'value' in option && option.value === 'default');
      expect(defaultModelOption).toMatchObject({
        value: 'default',
        name: 'Default — Opus 4.6',
      });
      expect(handle.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(
        'plan'
      );
    });

    it('throws when setSessionConfigOption call fails', async () => {
      setupSuccessfulSpawn();
      mockSetSessionConfigOption.mockRejectedValueOnce(new Error('Method not found'));
      await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await expect(manager.setConfigOption('session-1', 'model', 'opus')).rejects.toThrow(
        'Method not found'
      );
    });

    it('fails fast when setSessionConfigOption response omits required categories', async () => {
      setupSuccessfulSpawn();
      mockSetSessionConfigOption.mockResolvedValueOnce({
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
      await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await expect(manager.setConfigOption('session-1', 'mode', 'plan')).rejects.toThrow(
        'missing required config option categories: model, mode'
      );
    });
  });

  describe('setSessionMode', () => {
    it('calls ACP setSessionMode and updates cached mode currentValue', async () => {
      setupSuccessfulSpawn();
      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await manager.setSessionMode('session-1', 'plan');

      expect(mockSetSessionMode).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
        modeId: 'plan',
      });
      expect(handle.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(
        'plan'
      );
    });

    it('throws when setSessionMode call fails', async () => {
      setupSuccessfulSpawn();
      mockSetSessionMode.mockRejectedValueOnce(new Error('Invalid mode'));
      await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await expect(manager.setSessionMode('session-1', 'acceptEdits')).rejects.toThrow(
        'Invalid mode'
      );
    });
  });

  describe('setSessionModel', () => {
    it('uses unstable_setSessionModel for CLAUDE and updates cached model currentValue', async () => {
      setupSuccessfulSpawn();
      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await manager.setSessionModel('session-1', 'opus');

      expect(mockSetSessionModel).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
        modelId: 'opus',
      });
      expect(mockSetSessionConfigOption).not.toHaveBeenCalled();
      expect(handle.configOptions.find((option) => option.id === 'model')?.currentValue).toBe(
        'opus'
      );
    });

    it('falls back to setSessionConfigOption when unstable_setSessionModel is unavailable', async () => {
      setupSuccessfulSpawn();
      mockSetSessionModel.mockRejectedValueOnce({ code: -32_601, message: 'Method not found' });
      mockSetSessionConfigOption.mockResolvedValueOnce({
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            category: 'model',
            currentValue: 'opus',
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
            options: [{ value: 'default', name: 'Default' }],
          },
        ],
      });
      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await manager.setSessionModel('session-1', 'opus');

      expect(mockSetSessionModel).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
        modelId: 'opus',
      });
      expect(mockSetSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
        configId: 'model',
        value: 'opus',
      });
      expect(handle.configOptions.find((option) => option.id === 'model')?.currentValue).toBe(
        'opus'
      );
    });

    it('uses setSessionConfigOption path for CODEX model updates', async () => {
      setupSuccessfulSpawn();
      await manager.getOrCreateClient(
        'session-1',
        { ...defaultOptions(), provider: 'CODEX' },
        defaultHandlers(),
        defaultContext()
      );

      await manager.setSessionModel('session-1', 'gpt-5.2-codex');

      expect(mockSetSessionModel).not.toHaveBeenCalled();
      expect(mockSetSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
        configId: 'model',
        value: 'gpt-5.2-codex',
      });
    });
  });
});
