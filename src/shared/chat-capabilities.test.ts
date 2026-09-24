import { describe, expect, it } from 'vitest';
import { EMPTY_CHAT_BAR_CAPABILITIES, hasResolvedChatBarCapabilities } from './chat-capabilities';

describe('chat capabilities', () => {
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
    expect(
      hasResolvedChatBarCapabilities({
        provider: 'CLAUDE',
        model: {
          enabled: true,
          options: [
            { value: 'opus', label: 'Opus' },
            { value: 'sonnet', label: 'Sonnet' },
          ],
          selected: 'sonnet',
        },
        reasoning: { enabled: false, options: [] },
        thinking: { enabled: true, defaultBudget: 10_000 },
        planMode: { enabled: true },
        attachments: { enabled: true, kinds: ['image', 'text'] },
        slashCommands: { enabled: true },
        usageStats: { enabled: true, contextWindow: true },
        rewind: { enabled: true },
      })
    ).toBe(true);
    expect(
      hasResolvedChatBarCapabilities({
        provider: 'CODEX',
        model: { enabled: false, options: [] },
        reasoning: { enabled: false, options: [] },
        thinking: { enabled: false },
        planMode: { enabled: true },
        attachments: { enabled: false, kinds: [] },
        slashCommands: { enabled: false },
        usageStats: { enabled: false, contextWindow: false },
        rewind: { enabled: false },
      })
    ).toBe(true);
  });
});
