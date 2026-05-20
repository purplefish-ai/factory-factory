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
