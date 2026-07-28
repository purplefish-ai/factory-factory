import { describe, expect, it } from 'vitest';
import { getStatusBannerClassName } from './status-banner-styles';

describe('getStatusBannerClassName', () => {
  it.each([
    ['error', 'border-destructive/30 bg-destructive/10 text-destructive'],
    ['warning', 'border-warning/30 bg-warning/10 text-warning'],
    ['info', 'border-info/30 bg-info/10 text-info'],
  ] as const)('maps %s banners to theme-aware semantic colors', (kind, expected) => {
    expect(getStatusBannerClassName(kind)).toBe(expected);
  });

  it.each([
    'error',
    'warning',
    'info',
  ] as const)('does not use a fixed light-theme palette for %s banners', (kind) => {
    expect(getStatusBannerClassName(kind)).not.toMatch(/\b(?:bg|border|text)-(?:red|yellow|blue)-/);
  });
});
