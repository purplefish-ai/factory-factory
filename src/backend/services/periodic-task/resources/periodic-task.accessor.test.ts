import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  periodicTask: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  periodicTaskExecution: {
    create: vi.fn(),
  },
}));

vi.mock('@/backend/db', () => ({
  prisma: prismaMock,
}));

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

function localTime(date: Date, timezone: string): string {
  const parts = getLocalParts(date, timezone);
  return `${parts.hour}:${parts.minute}`;
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

describe('periodicTaskAccessor.markDispatched', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-28T15:00:00.000Z'));
    prismaMock.periodicTask.findUnique.mockReset();
    prismaMock.periodicTask.update.mockReset();
    prismaMock.$transaction.mockReset();
    prismaMock.periodicTaskExecution.create.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lazily backfills a legacy monthly anchor from createdAt in the task timezone', async () => {
    const timezone = 'America/Los_Angeles';
    prismaMock.periodicTask.findUnique.mockResolvedValue({
      createdAt: new Date('2026-02-01T07:30:00.000Z'), // Jan 31 23:30 in Los Angeles
      scheduledDayOfMonth: null,
      timezone,
    });
    prismaMock.periodicTask.update.mockResolvedValue({});

    await periodicTaskAccessor.markDispatched('task-1', 'MONTHLY', '09:00', timezone, null);

    expect(prismaMock.periodicTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: expect.objectContaining({
        scheduledDayOfMonth: 31,
      }),
    });

    const updateArgs = prismaMock.periodicTask.update.mock.calls[0]?.[0];
    const nextRunAt = updateArgs?.data.nextRunAt as Date;
    expect(getLocalParts(nextRunAt, timezone)).toMatchObject({
      year: '2026',
      month: '03',
      day: '31',
      hour: '09',
      minute: '00',
    });
  });
});

describe('periodicTaskAccessor.createExecutionAndMarkDispatched', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-28T15:00:00.000Z'));
    prismaMock.periodicTask.findUnique.mockReset();
    prismaMock.periodicTask.update.mockReset();
    prismaMock.periodicTaskExecution.create.mockReset();
    prismaMock.$transaction.mockReset();
    prismaMock.$transaction.mockImplementation(async (operations: Promise<unknown>[]) =>
      Promise.all(operations)
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates the execution and advances the schedule in one transaction', async () => {
    const execution = {
      id: 'exec-1',
      periodicTaskId: 'task-1',
      workspaceId: null,
      status: 'RUNNING',
    };
    const executionCreate = Promise.resolve(execution);
    const taskUpdate = Promise.resolve({});
    prismaMock.periodicTaskExecution.create.mockReturnValue(executionCreate);
    prismaMock.periodicTask.update.mockReturnValue(taskUpdate);

    await expect(
      periodicTaskAccessor.createExecutionAndMarkDispatched(
        {
          periodicTaskId: 'task-1',
          workspaceId: null,
          status: 'RUNNING',
        },
        {
          cadence: 'DAILY',
          scheduledTime: '09:00',
          timezone: 'UTC',
          scheduledDayOfMonth: null,
        }
      )
    ).resolves.toBe(execution);

    expect(prismaMock.periodicTaskExecution.create).toHaveBeenCalledWith({
      data: {
        periodicTaskId: 'task-1',
        workspaceId: null,
        status: 'RUNNING',
      },
    });
    expect(prismaMock.periodicTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: expect.objectContaining({
        lastRunAt: new Date('2026-02-28T15:00:00.000Z'),
        scheduledDayOfMonth: null,
        nextRunAt: new Date('2026-03-01T09:00:00.000Z'),
      }),
    });
    expect(prismaMock.$transaction).toHaveBeenCalledWith([executionCreate, taskUpdate]);
  });
});
