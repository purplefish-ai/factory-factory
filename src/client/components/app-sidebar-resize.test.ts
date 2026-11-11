import { describe, expect, it } from 'vitest';
import {
  clampSidebarWidth,
  parseSidebarWidth,
  StoredSidebarWidthSchema,
} from './app-sidebar-resize';

describe('app-sidebar resize helpers', () => {
  it('clamps width values to supported range', () => {
    expect(clampSidebarWidth(100)).toBe(240);
    expect(clampSidebarWidth(352.2)).toBe(352);
    expect(clampSidebarWidth(1000)).toBe(640);
  });

  it('parses persisted values and falls back to default for invalid values', () => {
    expect(parseSidebarWidth('480')).toBe(480);
    expect(parseSidebarWidth('999')).toBe(640);
    expect(parseSidebarWidth('not-a-number')).toBe(352);
    expect(parseSidebarWidth(null)).toBe(352);
  });

  it('reads the stored text format with clamping', () => {
    expect(StoredSidebarWidthSchema.parse('500')).toBe(500);
    expect(StoredSidebarWidthSchema.parse('999')).toBe(640);
  });
});
