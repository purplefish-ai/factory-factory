import { describe, expect, it } from 'vitest';
import {
  chatReducer,
  createActionFromWebSocketMessage,
  createInitialChatState,
} from '@/client/features/chat/reducer';
import { DEFAULT_CHAT_SETTINGS } from '@/lib/chat-protocol';

describe('config option updates', () => {
  it('keeps select controls when an update also includes boolean config options', () => {
    const select = {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'sonnet',
      options: [{ value: 'sonnet', name: 'Sonnet' }],
    };
    const action = createActionFromWebSocketMessage({
      type: 'config_options_update',
      configOptions: [select, { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false }],
    });
    expect(action).toEqual({ type: 'CONFIG_OPTIONS_UPDATE', payload: { configOptions: [select] } });
  });
});

it.each(['constructor', '__proto__', 'toString'])(
  'accepts an unrequested native model with prototype-like identifier %s',
  (id) => {
    const state = chatReducer(createInitialChatState(), {
      type: 'CONFIG_OPTIONS_UPDATE',
      payload: {
        configOptions: [
          {
            id,
            category: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'confirmed-model',
            options: [],
          },
        ],
      },
    });
    expect(state.chatSettings.selectedModel).toBe('confirmed-model');
    expect(state.modelSelectionSource).toBe('server');
  }
);

it.each(['constructor', '__proto__', 'toString'])(
  'reconciles native reasoning with prototype-like identifier %s after disconnect',
  (id) => {
    const disconnected = chatReducer(
      createInitialChatState({
        chatSettings: { ...DEFAULT_CHAT_SETTINGS, reasoningEffort: 'high' },
      }),
      { type: 'CONFIG_OPTIONS_DISCONNECTED' }
    );
    const state = chatReducer(disconnected, {
      type: 'CONFIG_OPTIONS_UPDATE',
      payload: {
        configOptions: [
          {
            id,
            category: 'reasoning',
            name: 'Reasoning',
            type: 'select',
            currentValue: 'low',
            options: [],
          },
        ],
      },
    });
    expect(state.chatSettings.reasoningEffort).toBe('low');
  }
);
