import { describe, expect, it } from 'vitest';
import {
  createClaudeChatBarCapabilities,
  createCodexChatBarCapabilities,
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
});
