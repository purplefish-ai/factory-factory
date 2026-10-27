import { describe, expect, it } from 'vitest';
import { DEFAULT_CHAT_SETTINGS } from '@/lib/chat-protocol';
import { type ChatBarCapabilities, EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { chatReducer, createInitialChatState } from './index';

const capabilities: ChatBarCapabilities = {
  ...EMPTY_CHAT_BAR_CAPABILITIES,
  model: {
    enabled: true,
    options: [
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
    ],
    selected: 'sonnet',
  },
  reasoning: {
    enabled: true,
    options: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ],
    selected: 'low',
  },
  thinking: { enabled: true },
  planMode: { enabled: true },
};
const restoredSettings = {
  selectedModel: 'opus',
  reasoningEffort: 'high',
  thinkingEnabled: true,
  planModeEnabled: true,
};

function hydrate(state = createInitialChatState()) {
  return chatReducer(state, { type: 'WS_CHAT_CAPABILITIES', payload: { capabilities } });
}

describe('settings hydration', () => {
  it('adopts the confirmed initial model instead of the bootstrap default', () => {
    expect(hydrate().chatSettings.selectedModel).toBe('sonnet');
  });

  it('preserves restored flags while capabilities are unknown and adopts the server model', () => {
    const restored = chatReducer(createInitialChatState(), {
      type: 'SET_SETTINGS',
      payload: restoredSettings,
    });
    expect(restored.chatSettings).toEqual(restoredSettings);
    expect(hydrate(restored).chatSettings).toEqual({
      ...restoredSettings,
      selectedModel: 'sonnet',
    });
  });

  it('preserves an explicit model edit through delayed initial capabilities', () => {
    const edited = chatReducer(createInitialChatState(), {
      type: 'UPDATE_SETTINGS',
      payload: { selectedModel: 'opus' },
    });
    expect(hydrate(edited).chatSettings.selectedModel).toBe('opus');
  });

  it('preserves a confirmed native model when the capability catalog is stale', () => {
    const configured = chatReducer(hydrate(), {
      type: 'CONFIG_OPTIONS_UPDATE',
      payload: {
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'new-model',
            options: [{ value: 'new-model', name: 'New model' }],
          },
        ],
      },
    });
    const edited = chatReducer(configured, {
      type: 'UPDATE_SETTINGS',
      payload: { planModeEnabled: true },
    });
    expect(hydrate(edited).chatSettings.selectedModel).toBe('new-model');
  });

  it.each([
    ['sonnet', 'claude-sonnet-5', true],
    ['sonnet[1m]', 'claude-sonnet-5[1m]', true],
    ['sonnet', 'claude-sonnet-5[1m]', false],
    ['sonnet[1m]', 'claude-sonnet-5', false],
    ['sonnet', 'claude-opus-5', false],
  ])(
    'confirms Claude alias %s with matching identity %s: %s',
    (selectedModel, currentValue, accepted) => {
      const edited = chatReducer(hydrate(), {
        type: 'UPDATE_SETTINGS',
        payload: { selectedModel },
      });
      const confirmed = chatReducer(edited, {
        type: 'CONFIG_OPTIONS_UPDATE',
        payload: {
          configOptions: [
            { id: 'model', name: 'Model', type: 'select', currentValue, options: [] },
          ],
        },
      });
      expect(confirmed.chatSettings.selectedModel).toBe(accepted ? currentValue : selectedModel);
      expect(confirmed.modelSelectionSource).toBe(accepted ? 'server' : 'local');
    }
  );

  it('retains model configuration through a partial unrelated options update', () => {
    const model = {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'sonnet',
      options: [{ value: 'sonnet', name: 'Sonnet' }],
    };
    const mode = { id: 'mode', name: 'Mode', type: 'select', currentValue: 'default', options: [] };
    const configured = chatReducer(hydrate(), {
      type: 'CONFIG_OPTIONS_UPDATE',
      payload: { configOptions: [model] },
    });
    const partial = chatReducer(configured, {
      type: 'CONFIG_OPTIONS_UPDATE',
      payload: { configOptions: [mode] },
    });
    expect(partial.acpConfigOptions).toEqual([model, mode]);
    expect(partial.chatSettings.selectedModel).toBe('sonnet');
  });

  it('keeps a confirmed model through a later settings restore', () => {
    const restored = chatReducer(hydrate(), { type: 'SET_SETTINGS', payload: restoredSettings });
    expect(restored.chatSettings.selectedModel).toBe('sonnet');
  });

  it('treats a received empty capability payload as confirmed unsupported settings', () => {
    const restored = chatReducer(createInitialChatState(), {
      type: 'SET_SETTINGS',
      payload: restoredSettings,
    });
    const unsupported = chatReducer(restored, {
      type: 'WS_CHAT_CAPABILITIES',
      payload: { capabilities: EMPTY_CHAT_BAR_CAPABILITIES },
    });
    expect(unsupported.chatSettings).toEqual({ ...DEFAULT_CHAT_SETTINGS, reasoningEffort: null });
  });

  it('resets selection authority when switching sessions', () => {
    const edited = chatReducer(hydrate(), {
      type: 'UPDATE_SETTINGS',
      payload: { selectedModel: 'opus' },
    });
    const switched = chatReducer(edited, { type: 'SESSION_SWITCH_START' });
    const restored = chatReducer(switched, { type: 'SET_SETTINGS', payload: restoredSettings });
    expect(restored.chatSettings).toEqual(restoredSettings);
    expect(hydrate(restored).chatSettings.selectedModel).toBe('sonnet');
  });
});
