import { Sparkles, Zap } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { getQuickActionIcon } from './quick-action-icons';

describe('getQuickActionIcon', () => {
  it('returns the configured icon for known names', () => {
    expect(getQuickActionIcon('sparkles')).toBe(Sparkles);
  });

  it('falls back to Zap for prototype keys', () => {
    expect(getQuickActionIcon('__proto__')).toBe(Zap);
  });
});
