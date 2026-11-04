import { describe, expect, it } from 'vitest';
import { getStatusBannerClassName } from './status-banner-styles';

describe('getStatusBannerClassName', () => {
  it.each([
    [
      'error',
      'border-destructive-accent/50 bg-destructive-accent/15 dark:border-destructive/30 text-destructive dark:bg-destructive/10',
    ],
    [
      'warning',
      'border-warning-accent/50 bg-warning-accent/15 dark:border-warning/30 text-warning dark:bg-warning/10',
    ],
    [
      'info',
      'border-info-accent/50 bg-info-accent/15 dark:border-info/30 text-info dark:bg-info/10',
    ],
  ] as const)('maps %s banners to theme-aware semantic colors', (kind, expected) => {
    expect(getStatusBannerClassName(kind)).toBe(expected);
  });

  it.each(['error', 'warning', 'info'] as const)(
    'does not use a fixed light-theme palette for %s banners',
    (kind) => {
      expect(getStatusBannerClassName(kind)).not.toMatch(
        /\b(?:bg|border|text)-(?:red|yellow|blue)-/
      );
    }
  );
});
