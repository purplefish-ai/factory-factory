import { describe, expect, it } from 'vitest';
import { createEmptyTokenStats } from '@/lib/chat-protocol';
import { calculateContextUsagePercentage } from './usage-stats-utils';

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
