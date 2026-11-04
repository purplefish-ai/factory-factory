import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, toDateTimeIso } from './date-time';

const instant = '2026-11-04T10:23:45.678Z';
const utc = { locale: 'en-US', timeZone: 'UTC' };

describe('client date and time presentation', () => {
  it('uses the same date and minute precision for dates from each transport', () => {
    for (const value of [instant, new Date(instant), Date.parse(instant)]) {
      expect(formatDateTime(value, utc)).toBe('Nov 4, 2026, 10:23 AM');
    }
  });

  it('keeps seconds for diagnostic dates while ISO attributes retain milliseconds', () => {
    expect(formatDateTime(instant, { ...utc, precision: 'second' })).toBe(
      'Nov 4, 2026, 10:23:45 AM'
    );
    expect(toDateTimeIso(instant)).toBe(instant);
  });

  it('honors the requested locale and time zone, including a different calendar day', () => {
    expect(formatDateTime(instant, { locale: 'en-GB', timeZone: 'America/New_York' })).toBe(
      '4 Nov 2026, 5:23'
    );
    expect(formatDate('2026-11-04T02:00:00Z', { ...utc, timeZone: 'America/Los_Angeles' })).toBe(
      'Nov 3, 2026'
    );
    expect(formatDate(instant, utc)).toBe('Nov 4, 2026');
  });

  it.each([null, undefined, '', 'not a date', new Date(Number.NaN), Number.NaN, Infinity])(
    'provides a readable fallback and omits invalid machine dates for %s',
    (value) => {
      expect(formatDate(value, utc)).toBe('Unknown date');
      expect(formatDateTime(value, utc)).toBe('Unknown date');
      expect(toDateTimeIso(value)).toBeUndefined();
    }
  );

  it('keeps the Unix epoch valid and does not change Date inputs', () => {
    const date = new Date(instant);
    expect(toDateTimeIso(0)).toBe('1970-01-01T00:00:00.000Z');
    formatDateTime(date, utc);
    expect(date.toISOString()).toBe(instant);
  });
});
