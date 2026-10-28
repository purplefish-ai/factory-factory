import { expect, it } from 'vitest';
import {
  clampChatSettingsForCapabilities,
  getConfigOptionSettings,
} from '@/client/features/chat/chat-settings';
import { createInitialChatState, type ChatState } from '@/client/features/chat/reducer';
import { DEFAULT_CHAT_SETTINGS } from '@/lib/chat-protocol';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';

it.each([null, 'medium'])(
  'does not turn an unknown effort (%s) into the first advertised option',
  (reasoningEffort) => {
    const capabilities = {
      ...EMPTY_CHAT_BAR_CAPABILITIES,
      reasoning: {
        enabled: true,
        options: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' },
        ],
      },
    };
    const pending = clampChatSettingsForCapabilities(
      { ...DEFAULT_CHAT_SETTINGS, reasoningEffort },
      capabilities
    );
    expect(pending.reasoningEffort).toBeNull();
    expect(
      clampChatSettingsForCapabilities(pending, {
        ...capabilities,
        reasoning: { ...capabilities.reasoning, selected: 'high' },
      }).reasoningEffort
    ).toBe('high');
  }
);

it.each([
  ['thought_level', undefined],
  ['reasoning_effort', undefined],
  ['custom-effort', 'thought_level'],
  ['custom-effort', 'reasoning'],
])('mirrors native reasoning %s (category %s) into outbound settings', (id, category) => {
  const state: ChatState = {
    ...createInitialChatState(),
    acpConfigOptions: [
      { id, category, name: 'Thinking', type: 'select', currentValue: 'low', options: [] },
    ],
  };
  expect(getConfigOptionSettings(state, id, 'high')).toEqual({ reasoningEffort: 'high' });
});
