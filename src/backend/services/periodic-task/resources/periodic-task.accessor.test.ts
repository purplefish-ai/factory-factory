import { describe, expect, it } from 'vitest';
import { periodicTaskAccessor } from './periodic-task.accessor';

function calendarDate(date: Date, timezone = 'UTC'): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value])
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localTime(date: Date, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value])
  );

  return `${parts.hour}:${parts.minute}`;
}

describe('periodicTaskAccessor.computeNextRunAt', () => {
  it('preserves the anchored monthly day after clamping for a short month', () => {
    const february = periodicTaskAccessor.computeNextRunAt(
      'MONTHLY',
      new Date('2026-01-31T12:00:00.000Z'),
      null,
      null,
      31
    );
    const march = periodicTaskAccessor.computeNextRunAt('MONTHLY', february, null, null, 31);

    expect(calendarDate(february)).toBe('2026-02-28');
    expect(calendarDate(march)).toBe('2026-03-31');
  });

  it('preserves a day 30 monthly anchor after February', () => {
    const february = periodicTaskAccessor.computeNextRunAt(
      'MONTHLY',
      new Date('2026-01-30T12:00:00.000Z'),
      null,
      null,
      30
    );
    const march = periodicTaskAccessor.computeNextRunAt('MONTHLY', february, null, null, 30);

    expect(calendarDate(february)).toBe('2026-02-28');
    expect(calendarDate(march)).toBe('2026-03-30');
  });

  it('handles leap-year February while preserving a day 31 monthly anchor', () => {
    const february = periodicTaskAccessor.computeNextRunAt(
      'MONTHLY',
      new Date('2028-01-31T12:00:00.000Z'),
      null,
      null,
      31
    );
    const march = periodicTaskAccessor.computeNextRunAt('MONTHLY', february, null, null, 31);

    expect(calendarDate(february)).toBe('2028-02-29');
    expect(calendarDate(march)).toBe('2028-03-31');
  });

  it('falls back to the dispatch date for legacy rows without a monthly anchor', () => {
    const next = periodicTaskAccessor.computeNextRunAt(
      'MONTHLY',
      new Date('2026-02-28T12:00:00.000Z')
    );

    expect(calendarDate(next)).toBe('2026-03-28');
  });

  it('applies scheduled time in timezone without losing the monthly anchor', () => {
    const timezone = 'America/New_York';
    const february = periodicTaskAccessor.computeNextRunAt(
      'MONTHLY',
      new Date('2026-01-31T15:00:00.000Z'),
      '09:30',
      timezone,
      31
    );
    const march = periodicTaskAccessor.computeNextRunAt('MONTHLY', february, '09:30', timezone, 31);

    expect(calendarDate(february, timezone)).toBe('2026-02-28');
    expect(localTime(february, timezone)).toBe('09:30');
    expect(calendarDate(march, timezone)).toBe('2026-03-31');
    expect(localTime(march, timezone)).toBe('09:30');
  });
});
