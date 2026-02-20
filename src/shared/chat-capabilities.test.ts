import { describe, expect, it } from 'vitest';
import {
  createClaudeChatBarCapabilities,
  createCodexChatBarCapabilities,
  EMPTY_CHAT_BAR_CAPABILITIES,
  hasResolvedChatBarCapabilities,
} from './chat-capabilities';

describe('chat capabilities', () => {
  it('keeps Claude reasoning controls disabled', () => {
    const capabilities = createClaudeChatBarCapabilities('sonnet');

    expect(capabilities.reasoning).toEqual({
      enabled: false,
      options: [],
    });
  });

  it('derives Codex model and reasoning options from model/list payload', () => {
    const capabilities = createCodexChatBarCapabilities({
      models: [
        {
          model: 'gpt-5.3-codex',
          displayName: 'gpt-5.3-codex',
          isDefault: true,
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Low' },
            { reasoningEffort: 'medium', description: 'Medium' },
            { reasoningEffort: 'high', description: 'High' },
          ],
        },
      ],
      selectedModel: 'gpt-5.3-codex',
      selectedReasoningEffort: 'high',
    });

    expect(capabilities.model.selected).toBe('gpt-5.3-codex');
    expect(capabilities.reasoning.enabled).toBe(true);
    expect(capabilities.reasoning.selected).toBe('high');
    expect(capabilities.reasoning.options.map((option) => option.value)).toEqual([
      'low',
      'medium',
      'high',
    ]);
  });

  it('marks placeholder capabilities as unresolved', () => {
    expect(hasResolvedChatBarCapabilities(EMPTY_CHAT_BAR_CAPABILITIES)).toBe(false);
    expect(
      hasResolvedChatBarCapabilities(JSON.parse(JSON.stringify(EMPTY_CHAT_BAR_CAPABILITIES)))
    ).toBe(false);
  });

  it('returns false for null and undefined', () => {
    expect(hasResolvedChatBarCapabilities(null)).toBe(false);
    expect(hasResolvedChatBarCapabilities(undefined)).toBe(false);
  });

  it('marks real provider capabilities as resolved', () => {
    expect(hasResolvedChatBarCapabilities(createClaudeChatBarCapabilities('sonnet'))).toBe(true);
    expect(hasResolvedChatBarCapabilities(createCodexChatBarCapabilities())).toBe(true);
  });
});
