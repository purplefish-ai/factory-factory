import { describe, expect, it, vi } from 'vitest';

vi.mock('@/backend/db', () => ({
  prisma: {},
}));

import { periodicTaskAccessor } from './periodic-task.accessor';

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
});
