import { describe, expect, it } from 'vitest';
import { resolveAgentSchedule } from './agent-schedule';

describe('resolveAgentSchedule', () => {
  it('preserves the stored timezone when the clock time is unchanged', () => {
    expect(
      resolveAgentSchedule(
        { cadence: 'WEEKLY', scheduledTime: '09:30' },
        { scheduledTime: '09:30', timezone: 'Asia/Tokyo' },
        'America/New_York'
      )
    ).toEqual({ scheduledTime: '09:30', timezone: 'Asia/Tokyo' });
  });
  it('uses browser timezone when changing or adding a clock time', () => {
    expect(
      resolveAgentSchedule(
        { cadence: 'DAILY', scheduledTime: '10:00' },
        { scheduledTime: '09:30', timezone: 'Asia/Tokyo' },
        'America/New_York'
      )
    ).toEqual({ scheduledTime: '10:00', timezone: 'America/New_York' });
    expect(
      resolveAgentSchedule({ cadence: 'DAILY', scheduledTime: '10:00' }, undefined, 'Europe/Paris')
        .timezone
    ).toBe('Europe/Paris');
  });
  it('clears both fields for minute cadences and an empty clock time', () => {
    for (const cadence of ['EVERY_MINUTE', 'EVERY_FIVE_MINUTES', 'DAILY'] as const) {
      expect(
        resolveAgentSchedule({ cadence, scheduledTime: cadence === 'DAILY' ? '' : '09:30' })
      ).toEqual({ scheduledTime: null, timezone: null });
    }
  });
});
