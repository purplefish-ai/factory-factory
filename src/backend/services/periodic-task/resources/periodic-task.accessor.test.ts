import { describe, expect, it, vi } from 'vitest';

vi.mock('@/backend/db', () => ({
  prisma: {},
}));

import { periodicTaskAccessor } from './periodic-task.accessor';

function getLocalParts(date: Date, timezone: string) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value])
  );
}

describe('periodicTaskAccessor.computeNextRunAt', () => {
  it('keeps scheduled time on the spring-forward DST transition day', () => {
    const nextRunAt = periodicTaskAccessor.computeNextRunAt(
      'DAILY',
      new Date('2024-03-09T12:00:00.000Z'),
      '03:30',
      'America/New_York'
    );

    expect(nextRunAt.toISOString()).toBe('2024-03-10T07:30:00.000Z');
  });

  it('runs at the first valid later time when scheduled time does not exist', () => {
    const nextRunAt = periodicTaskAccessor.computeNextRunAt(
      'DAILY',
      new Date('2024-03-09T12:00:00.000Z'),
      '02:30',
      'America/New_York'
    );

    expect(nextRunAt.toISOString()).toBe('2024-03-10T07:00:00.000Z');
  });

  it('keeps scheduled time on the fall-back DST transition day', () => {
    const nextRunAt = periodicTaskAccessor.computeNextRunAt(
      'DAILY',
      new Date('2024-11-02T12:00:00.000Z'),
      '03:30',
      'America/New_York'
    );

    expect(nextRunAt.toISOString()).toBe('2024-11-03T08:30:00.000Z');
  });

  it('preserves scheduled time for UTC+14 day boundaries', () => {
    const nextRunAt = periodicTaskAccessor.computeNextRunAt(
      'DAILY',
      new Date('2024-01-01T00:00:00.000Z'),
      '03:30',
      'Pacific/Kiritimati'
    );

    expect(nextRunAt.toISOString()).toBe('2024-01-01T13:30:00.000Z');
  });

  it('preserves scheduled time for UTC-12 day boundaries', () => {
    const nextRunAt = periodicTaskAccessor.computeNextRunAt(
      'DAILY',
      new Date('2024-01-01T12:00:00.000Z'),
      '23:30',
      'Etc/GMT+12'
    );

    expect(nextRunAt.toISOString()).toBe('2024-01-03T11:30:00.000Z');
  });

  it('does not snap short cadences to scheduled times', () => {
    const nextRunAt = periodicTaskAccessor.computeNextRunAt(
      'EVERY_FIVE_MINUTES',
      new Date('2024-03-09T12:00:00.000Z'),
      '03:30',
      'America/New_York'
    );

    expect(nextRunAt.toISOString()).toBe('2024-03-09T12:05:00.000Z');
  });

  it('keeps MONTHLY scheduled runs on the local clamped day near UTC rollover', () => {
    const timezone = 'America/New_York';
    const from = new Date('2026-01-31T00:05:00.000Z'); // Jan 30 19:05 in New York

    const nextRunAt = periodicTaskAccessor.computeNextRunAt('MONTHLY', from, '09:00', timezone);

    expect(getLocalParts(nextRunAt, timezone)).toMatchObject({
      year: '2026',
      month: '02',
      day: '28',
      hour: '09',
      minute: '00',
    });
  });

  it('preserves local Date monthly clamping when no timezone is configured', () => {
    const from = new Date(2026, 0, 31, 9, 5);

    const nextRunAt = periodicTaskAccessor.computeNextRunAt('MONTHLY', from);

    expect(nextRunAt.getTime()).toBe(new Date(2026, 1, 28, 9, 5).getTime());
  });
});
