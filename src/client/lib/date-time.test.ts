import { describe, expect, it, vi } from 'vitest';
import { type DateDisplayOptions, formatDate, formatDateTime, toDateTimeIso } from './date-time';

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
    expect(formatDateTime(instant, { ...utc, timeZone: 'America/New_York' })).toBe(
      'Nov 4, 2026, 5:23 AM'
    );
    expect(formatDateTime(instant, { ...utc, locale: 'en-GB' })).toBe('4 Nov 2026, 10:23');
  });

  it('accepts Locale objects and ordered locale preferences in cached configurations', () => {
    expect(formatDateTime(instant, { ...utc, locale: new Intl.Locale('en-GB') })).toBe(
      '4 Nov 2026, 10:23'
    );
    expect(formatDateTime(instant, { ...utc, locale: ['en-US', 'en-GB'] })).toBe(
      'Nov 4, 2026, 10:23 AM'
    );
  });

  it.each([
    {},
    { locale: 'en-US' },
    { timeZone: 'UTC' },
    { locale: [] },
    { locale: 'zz-ZZ', timeZone: 'UTC' },
    { locale: ['zz-ZZ'], timeZone: 'UTC' },
  ])(
    'follows changing browser defaults when a display option falls back: %j',
    (options: DateDisplayOptions) => {
      const NativeDateTimeFormat = Intl.DateTimeFormat;
      let defaultLocale = 'en-US';
      let defaultTimeZone = 'UTC';
      const effectiveLocale = (locales: Intl.LocalesArgument | undefined) => {
        const requested =
          locales === undefined
            ? []
            : Array.isArray(locales)
              ? locales.map(String)
              : [String(locales)];
        return NativeDateTimeFormat.supportedLocalesOf(requested).length === 0
          ? defaultLocale
          : requested;
      };
      const dateTimeFormatMock = vi.spyOn(Intl, 'DateTimeFormat');
      dateTimeFormatMock.mockImplementation(
        function formatWithCurrentDefaults(locales, formatOptions) {
          return new NativeDateTimeFormat(effectiveLocale(locales), {
            ...formatOptions,
            timeZone: formatOptions?.timeZone ?? defaultTimeZone,
          });
        }
      );
      Object.defineProperty(Intl.DateTimeFormat, 'supportedLocalesOf', {
        value: NativeDateTimeFormat.supportedLocalesOf,
      });
      try {
        const first = formatDateTime(instant, options);
        defaultLocale = 'en-GB';
        defaultTimeZone = 'America/New_York';
        const next = formatDateTime(instant, options);
        expect(next).not.toBe(first);
        expect(next).toBe(
          new NativeDateTimeFormat(effectiveLocale(options.locale), {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            timeZone: options.timeZone ?? defaultTimeZone,
          }).format(new Date(instant))
        );
      } finally {
        dateTimeFormatMock.mockRestore();
      }
    }
  );

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
