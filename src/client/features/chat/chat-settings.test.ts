import { expect, it } from 'vitest';
import { DEFAULT_CHAT_SETTINGS } from '@/lib/chat-protocol';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { clampChatSettingsForCapabilities } from './chat-settings';

it('does not turn an unknown effort into the first advertised option', () => {
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
  const pending = clampChatSettingsForCapabilities(DEFAULT_CHAT_SETTINGS, capabilities);
  expect(pending.reasoningEffort).toBeNull();
  expect(
    clampChatSettingsForCapabilities(pending, {
      ...capabilities,
      reasoning: { ...capabilities.reasoning, selected: 'high' },
    }).reasoningEffort
  ).toBe('high');
});
