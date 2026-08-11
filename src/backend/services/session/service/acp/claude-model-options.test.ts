import { describe, expect, it } from 'vitest';
import { formatClaudeModelOptionName } from './claude-model-options';

describe('formatClaudeModelOptionName', () => {
  it.each([
    [
      {
        value: 'default',
        name: 'Default (recommended)',
        description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks',
      },
      'Default — Opus 4.8 (1M)',
    ],
    [
      {
        value: 'opus[1m]',
        name: 'Opus',
        description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks',
      },
      'Opus 4.8 (1M)',
    ],
    [
      {
        value: 'claude-fable-5[1m]',
        name: 'Fable',
        description: 'Fable 5 · Most capable for hard tasks',
      },
      'Fable 5',
    ],
    [
      { value: 'sonnet', name: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' },
      'Sonnet 5',
    ],
    [
      { value: 'haiku', name: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
      'Haiku 4.5',
    ],
    [{ value: 'custom', name: 'My Custom Model', description: undefined }, 'My Custom Model'],
  ])('formats $value as an explicit concise label', (option, expected) => {
    expect(formatClaudeModelOptionName(option)).toBe(expected);
  });

  it('keeps the provider name when the leading description segment is capability prose', () => {
    expect(
      formatClaudeModelOptionName({
        value: 'sonnet',
        name: 'Sonnet',
        description: 'Fast responses with 1M context · Efficient for routine tasks',
      })
    ).toBe('Sonnet');
  });
});
