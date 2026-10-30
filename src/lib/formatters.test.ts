import { describe, expect, it } from 'vitest';
import { formatBytes, formatCpu, formatDateTimeShort, formatIdleTime } from './formatters';

describe('formatBytes', () => {
  it('formats null/undefined as -', () => {
    expect(formatBytes(null)).toBe('-');
    expect(formatBytes(undefined)).toBe('-');
  });

  it('formats bytes correctly', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(1500)).toBe('1.5 KB');
    expect(formatBytes(1_500_000)).toBe('1.4 MB');
    expect(formatBytes(1_500_000_000)).toBe('1.40 GB');
  });
});

describe('formatCpu', () => {
  it('formats null/undefined as -', () => {
    expect(formatCpu(null)).toBe('-');
    expect(formatCpu(undefined)).toBe('-');
  });

  it('formats CPU percentage correctly', () => {
    expect(formatCpu(25.5)).toBe('25.5%');
    expect(formatCpu(100)).toBe('100.0%');
  });
});

describe('formatIdleTime', () => {
  it('formats null/undefined as -', () => {
    expect(formatIdleTime(null)).toBe('-');
    expect(formatIdleTime(undefined)).toBe('-');
  });

  it('formats idle time correctly', () => {
    expect(formatIdleTime(500)).toBe('500ms');
    expect(formatIdleTime(5000)).toBe('5s');
    expect(formatIdleTime(120_000)).toBe('2.0m');
  });
});

describe('formatDateTimeShort', () => {
  it('formats a valid date string', () => {
    // ICU versions differ in the space before the day period.
    expect(formatDateTimeShort('2024-01-15T14:30:00')).toMatch(/^Jan 15, 02:30\sPM$/);
  });

  it('falls back to the input for an unparseable date', () => {
    expect(formatDateTimeShort('not-a-date')).toBe('not-a-date');
  });
});
