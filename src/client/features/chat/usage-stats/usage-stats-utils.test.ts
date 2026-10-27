import { describe, expect, it } from 'vitest';
import { createEmptyTokenStats } from '@/lib/chat-protocol';
import { calculateContextUsagePercentage, getUsageColorClass } from './usage-stats-utils';

describe('context percentage', () => {
  it('never derives current context from accumulated tokens', () => {
    expect(
      calculateContextUsagePercentage({
        ...createEmptyTokenStats(),
        inputTokens: 190_000,
        contextWindow: 200_000,
      })
    ).toBe(0);
  });
  it('uses the latest snapshot independently of accounting totals', () => {
    expect(
      calculateContextUsagePercentage({
        ...createEmptyTokenStats(),
        inputTokens: 900_000,
        contextUsedTokens: 40_000,
        contextWindow: 200_000,
      })
    ).toBe(20);
  });
});

describe('usage colors', () => {
  it.each([
    [null, 'text-muted-foreground'],
    [79, 'text-muted-foreground'],
    [80, 'text-yellow-500'],
    [94, 'text-yellow-500'],
    [95, 'text-red-500'],
  ])('uses shared warning thresholds at %s percent', (percent, expected) => {
    expect(getUsageColorClass(percent)).toBe(expected);
  });
  it('allows the combined control to preserve its accessible amber warning palette', () => {
    expect(getUsageColorClass(85, 'text-amber-600 dark:text-amber-400')).toBe(
      'text-amber-600 dark:text-amber-400'
    );
  });
});
