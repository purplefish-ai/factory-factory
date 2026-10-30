import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  periodicTask: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
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
  beforeEach(() => vi.stubEnv('TZ', 'UTC'));
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    ['DAILY', '2024-11-03T04:00:00.000Z', '00:00', '2024-11-04T05:00:00.000Z'],
    ['DAILY', '2024-03-10T04:00:00.000Z', '23:00', '2024-03-11T03:00:00.000Z'],
    ['WEEKLY', '2024-11-03T04:00:00.000Z', '00:00', '2024-11-10T05:00:00.000Z'],
    ['WEEKLY', '2024-03-10T04:00:00.000Z', '23:00', '2024-03-17T03:00:00.000Z'],
    ['WEEKLY', '2024-12-29T05:00:00.000Z', '00:00', '2025-01-05T05:00:00.000Z'],
  ] as const)('advances %s by local calendar days from %s', (cadence, from, time, expected) => {
    const nextRunAt = periodicTaskAccessor.computeNextRunAt(
      cadence,
      new Date(from),
      time,
      'America/New_York'
    );
    expect(nextRunAt.toISOString()).toBe(expected);
    expect(nextRunAt.getTime()).toBeGreaterThan(new Date(from).getTime());
  });

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

  it('advances from the timezone month when no scheduled time is configured', () => {
    const timezone = 'Asia/Tokyo';
    const from = new Date('2024-01-31T15:00:27.123Z'); // Feb 1 in Tokyo

    const nextRunAt = periodicTaskAccessor.computeNextRunAt('MONTHLY', from, null, timezone, 1);

    expect(calendarDate(nextRunAt, timezone)).toBe('2024-03-01');
    expect(nextRunAt.toISOString()).toBe('2024-02-29T15:00:27.123Z');
  });

  it('preserves local Date monthly clamping when no timezone is configured', () => {
    const from = new Date(2026, 0, 31, 9, 5);

    const nextRunAt = periodicTaskAccessor.computeNextRunAt('MONTHLY', from);

    expect(nextRunAt.getTime()).toBe(new Date(2026, 1, 28, 9, 5).getTime());
  });
});

describe('periodicTaskAccessor.update', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-20T12:00:00.000Z'));
    prismaMock.periodicTask.findUniqueOrThrow.mockReset();
    prismaMock.periodicTask.update.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves a monthly anchor across non-monthly cadence changes', async () => {
    const monthlyTask = {
      cadence: 'MONTHLY',
      scheduledTime: '09:00',
      timezone: 'UTC',
      scheduledDayOfMonth: 15,
      createdAt: new Date('2026-01-15T09:00:00.000Z'),
    };
    prismaMock.periodicTask.findUniqueOrThrow
      .mockResolvedValueOnce(monthlyTask)
      .mockResolvedValueOnce({ ...monthlyTask, cadence: 'DAILY' });
    prismaMock.periodicTask.update.mockResolvedValue({});

    await periodicTaskAccessor.update('task-1', { cadence: 'DAILY' });

    const dailyUpdate = prismaMock.periodicTask.update.mock.calls[0]?.[0];
    expect(dailyUpdate?.data).not.toHaveProperty('scheduledDayOfMonth');

    vi.setSystemTime(new Date('2026-01-25T12:00:00.000Z'));
    await periodicTaskAccessor.update('task-1', { cadence: 'MONTHLY' });

    const monthlyUpdate = prismaMock.periodicTask.update.mock.calls[1]?.[0];
    expect(monthlyUpdate?.data).toMatchObject({
      cadence: 'MONTHLY',
      scheduledDayOfMonth: 15,
      nextRunAt: new Date('2026-02-15T09:00:00.000Z'),
    });
  });

  it('uses the current local day when a task first becomes monthly', async () => {
    vi.setSystemTime(new Date('2026-01-20T02:00:00.000Z'));
    prismaMock.periodicTask.findUniqueOrThrow.mockResolvedValue({
      cadence: 'DAILY',
      scheduledTime: '09:00',
      timezone: 'America/New_York',
      scheduledDayOfMonth: null,
      createdAt: new Date('2025-12-03T14:00:00.000Z'),
    });
    prismaMock.periodicTask.update.mockResolvedValue({});

    await periodicTaskAccessor.update('task-1', { cadence: 'MONTHLY' });

    const update = prismaMock.periodicTask.update.mock.calls[0]?.[0];
    expect(update?.data).toMatchObject({
      cadence: 'MONTHLY',
      scheduledDayOfMonth: 19,
      nextRunAt: new Date('2026-02-19T14:00:00.000Z'),
    });
  });
});

describe('periodicTaskAccessor.toggleEnabled', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-20T12:00:00.000Z'));
    prismaMock.periodicTask.findUniqueOrThrow.mockReset();
    prismaMock.periodicTask.update.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves a dormant monthly anchor when enabling a non-monthly task', async () => {
    prismaMock.periodicTask.findUniqueOrThrow.mockResolvedValue({
      cadence: 'DAILY',
      scheduledTime: '09:00',
      timezone: 'UTC',
      scheduledDayOfMonth: 15,
      createdAt: new Date('2026-01-15T09:00:00.000Z'),
    });
    prismaMock.periodicTask.update.mockResolvedValue({});

    await periodicTaskAccessor.toggleEnabled('task-1', true);

    const update = prismaMock.periodicTask.update.mock.calls[0]?.[0];
    expect(update?.data).not.toHaveProperty('scheduledDayOfMonth');
    expect(update?.data).toMatchObject({
      isEnabled: true,
      nextRunAt: new Date('2026-01-21T09:00:00.000Z'),
    });
  });
});

describe('periodicTaskAccessor.reserveExecutionAndMarkDispatched', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-28T15:00:00.000Z'));
    prismaMock.periodicTask.findUnique.mockReset();
    prismaMock.periodicTask.update.mockReset();
    prismaMock.periodicTask.updateMany.mockReset();
    prismaMock.periodicTaskExecution.create.mockReset();
    prismaMock.$transaction.mockReset();
    prismaMock.$transaction.mockImplementation(async (operation) => operation(prismaMock));
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
    prismaMock.periodicTaskExecution.create.mockResolvedValue(execution);
    prismaMock.periodicTask.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      periodicTaskAccessor.reserveExecutionAndMarkDispatched(
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
          dueAt: new Date('2026-02-28T15:00:00.000Z'),
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
    expect(prismaMock.periodicTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'task-1',
        isEnabled: true,
        nextRunAt: { lte: new Date('2026-02-28T15:00:00.000Z') },
        project: { isArchived: false },
        executions: { none: { status: 'RUNNING' } },
      },
      data: expect.objectContaining({
        lastRunAt: new Date('2026-02-28T15:00:00.000Z'),
        scheduledDayOfMonth: null,
        nextRunAt: new Date('2026-03-01T09:00:00.000Z'),
      }),
    });
    expect(prismaMock.$transaction).toHaveBeenCalledOnce();
  });

  it('does not create an execution when the conditional reservation loses the race', async () => {
    prismaMock.periodicTask.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      periodicTaskAccessor.reserveExecutionAndMarkDispatched(
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
          dueAt: new Date('2026-02-28T15:00:00.000Z'),
        }
      )
    ).resolves.toBeNull();

    expect(prismaMock.periodicTaskExecution.create).not.toHaveBeenCalled();
  });

  it('lazily backfills a legacy monthly anchor from createdAt in the task timezone', async () => {
    const timezone = 'America/Los_Angeles';
    prismaMock.periodicTask.findUnique.mockResolvedValue({
      createdAt: new Date('2026-02-01T07:30:00.000Z'), // Jan 31 23:30 in Los Angeles
      scheduledDayOfMonth: null,
      timezone,
    });
    prismaMock.periodicTaskExecution.create.mockResolvedValue({
      id: 'exec-1',
      periodicTaskId: 'task-1',
      workspaceId: null,
      status: 'RUNNING',
    });
    prismaMock.periodicTask.updateMany.mockResolvedValue({ count: 1 });

    await periodicTaskAccessor.reserveExecutionAndMarkDispatched(
      {
        periodicTaskId: 'task-1',
        workspaceId: null,
        status: 'RUNNING',
      },
      {
        cadence: 'MONTHLY',
        scheduledTime: '09:00',
        timezone,
        scheduledDayOfMonth: null,
        dueAt: new Date('2026-02-28T15:00:00.000Z'),
      }
    );

    expect(prismaMock.periodicTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'task-1',
        isEnabled: true,
        nextRunAt: { lte: new Date('2026-02-28T15:00:00.000Z') },
        project: { isArchived: false },
        executions: { none: { status: 'RUNNING' } },
      },
      data: expect.objectContaining({
        scheduledDayOfMonth: 31,
      }),
    });

    const updateArgs = prismaMock.periodicTask.updateMany.mock.calls[0]?.[0];
    const nextRunAt = updateArgs?.data.nextRunAt as Date;
    expect(getLocalParts(nextRunAt, timezone)).toMatchObject({
      year: '2026',
      month: '03',
      day: '31',
      hour: '09',
      minute: '00',
    });
  });

  function reservedNextRunAt(): Date {
    const call = prismaMock.periodicTask.updateMany.mock.calls[0]?.[0] as
      | { data: { nextRunAt: Date } }
      | undefined;
    if (!call) {
      throw new Error('updateMany was not called');
    }
    return call.data.nextRunAt;
  }

  async function reserveLate(
    dispatchedAt: string,
    schedule: {
      cadence: 'EVERY_FIVE_MINUTES' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
      scheduledTime: string | null;
      timezone: string | null;
      scheduledDayOfMonth: number | null;
      dueAt: Date;
    }
  ): Promise<Date> {
    vi.setSystemTime(new Date(dispatchedAt));
    prismaMock.periodicTask.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.periodicTaskExecution.create.mockResolvedValue({ id: 'exec-1' });
    await periodicTaskAccessor.reserveExecutionAndMarkDispatched(
      { periodicTaskId: 'task-1', workspaceId: null, status: 'RUNNING' },
      schedule
    );
    return reservedNextRunAt();
  }

  it('keeps the next daily slot when a run is picked up just past local midnight', async () => {
    // Due 2024-01-01 23:59 America/New_York; picked up 90s later, at
    // 2024-01-02 00:00:30 local. The next slot is 2024-01-02 23:59 local, not
    // 2024-01-03 23:59, which would silently drop Jan 2's run.
    const nextRunAt = await reserveLate('2024-01-02T05:00:30.000Z', {
      cadence: 'DAILY',
      scheduledTime: '23:59',
      timezone: 'America/New_York',
      scheduledDayOfMonth: null,
      dueAt: new Date('2024-01-02T04:59:00.000Z'),
    });

    expect(nextRunAt.toISOString()).toBe('2024-01-03T04:59:00.000Z');
  });

  it('keeps the next monthly slot when a day-31 run is picked up just past midnight', async () => {
    // Due 2024-01-31 23:59 America/New_York; picked up at 2024-02-01 00:00:30
    // local. February's clamped slot is 2024-02-29 23:59 local
    // (= 2024-03-01T04:59Z), not 2024-03-31 23:59 local.
    const nextRunAt = await reserveLate('2024-02-01T05:00:30.000Z', {
      cadence: 'MONTHLY',
      scheduledTime: '23:59',
      timezone: 'America/New_York',
      scheduledDayOfMonth: 31,
      dueAt: new Date('2024-02-01T04:59:00.000Z'),
    });

    expect(nextRunAt.toISOString()).toBe('2024-03-01T04:59:00.000Z');
  });

  it('measures dispatch time after the legacy monthly anchor lookup', async () => {
    // The lookup finishes after the following slot (2026-02-28 09:00 UTC) has
    // passed, so that slot must not be reserved as the next, already-due run.
    vi.setSystemTime(new Date('2026-02-28T08:59:59.900Z'));
    prismaMock.periodicTask.findUnique.mockImplementation(() => {
      vi.setSystemTime(new Date('2026-02-28T09:00:01.000Z'));
      return Promise.resolve({
        createdAt: new Date('2026-01-31T12:00:00.000Z'),
        scheduledDayOfMonth: null,
        timezone: 'UTC',
      });
    });
    prismaMock.periodicTask.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.periodicTaskExecution.create.mockResolvedValue({ id: 'exec-1' });

    await periodicTaskAccessor.reserveExecutionAndMarkDispatched(
      { periodicTaskId: 'task-1', workspaceId: null, status: 'RUNNING' },
      {
        cadence: 'MONTHLY',
        scheduledTime: '09:00',
        timezone: 'UTC',
        scheduledDayOfMonth: null,
        dueAt: new Date('2026-01-31T09:00:00.000Z'),
      }
    );

    const data = prismaMock.periodicTask.updateMany.mock.calls[0]?.[0].data;
    expect(data.lastRunAt).toEqual(new Date('2026-02-28T09:00:01.000Z'));
    expect(data.nextRunAt).toEqual(new Date('2026-03-31T09:00:00.000Z'));
  });

  it("keeps today's daily slot when a task overdue by days is picked up before it", async () => {
    // Due 2024-01-01 09:00 America/New_York but the machine slept until
    // 2024-01-05 08:00 local. One run covers the missed slots, and the schedule
    // resumes at today's 09:00 slot rather than replaying Jan 2-4 or skipping
    // to Jan 6.
    const nextRunAt = await reserveLate('2024-01-05T13:00:00.000Z', {
      cadence: 'DAILY',
      scheduledTime: '09:00',
      timezone: 'America/New_York',
      scheduledDayOfMonth: null,
      dueAt: new Date('2024-01-01T14:00:00.000Z'),
    });

    expect(nextRunAt.toISOString()).toBe('2024-01-05T14:00:00.000Z');
  });

  it("keeps today's daily slot when a task overdue by days is picked up past midnight", async () => {
    // Due 2024-01-01 09:00 America/New_York; the app was off for two days and
    // picks the task up at 2024-01-03 00:00:30 local, just past the day
    // boundary. Jan 3's 09:00 slot is still ahead and must not be skipped.
    const nextRunAt = await reserveLate('2024-01-03T05:00:30.000Z', {
      cadence: 'DAILY',
      scheduledTime: '09:00',
      timezone: 'America/New_York',
      scheduledDayOfMonth: null,
      dueAt: new Date('2024-01-01T14:00:00.000Z'),
    });

    expect(nextRunAt.toISOString()).toBe('2024-01-03T14:00:00.000Z');
  });

  it("moves to tomorrow when today's daily slot has already passed", async () => {
    // Slept until 2024-01-05 10:00 local: the catch-up run covers today's
    // 09:00 slot too, so the next run is 2024-01-06 09:00 local.
    const nextRunAt = await reserveLate('2024-01-05T15:00:00.000Z', {
      cadence: 'DAILY',
      scheduledTime: '09:00',
      timezone: 'America/New_York',
      scheduledDayOfMonth: null,
      dueAt: new Date('2024-01-01T14:00:00.000Z'),
    });

    expect(nextRunAt.toISOString()).toBe('2024-01-06T14:00:00.000Z');
  });

  it('keeps the weekly weekday when a task overdue by weeks is caught up', async () => {
    // Monday 2024-01-01 09:00 America/New_York, picked up Wednesday Jan 10.
    // The next slot is Monday Jan 15, not Wednesday Jan 17.
    const nextRunAt = await reserveLate('2024-01-10T17:00:00.000Z', {
      cadence: 'WEEKLY',
      scheduledTime: '09:00',
      timezone: 'America/New_York',
      scheduledDayOfMonth: null,
      dueAt: new Date('2024-01-01T14:00:00.000Z'),
    });

    expect(nextRunAt.toISOString()).toBe('2024-01-15T14:00:00.000Z');
  });

  it("keeps this month's slot when a monthly task overdue by months is caught up", async () => {
    // Day 15 at 09:00 America/New_York, due Jan 15 and picked up Mar 10 (the
    // DST start day). March 15 09:00 EDT is still ahead, so April is not next.
    const nextRunAt = await reserveLate('2024-03-10T17:00:00.000Z', {
      cadence: 'MONTHLY',
      scheduledTime: '09:00',
      timezone: 'America/New_York',
      scheduledDayOfMonth: 15,
      dueAt: new Date('2024-01-15T14:00:00.000Z'),
    });

    expect(nextRunAt.toISOString()).toBe('2024-03-15T13:00:00.000Z');
  });

  it('keeps the minute-cadence grid when a run is overdue by several periods', async () => {
    const nextRunAt = await reserveLate('2024-01-01T12:12:30.000Z', {
      cadence: 'EVERY_FIVE_MINUTES',
      scheduledTime: null,
      timezone: null,
      scheduledDayOfMonth: null,
      dueAt: new Date('2024-01-01T12:00:00.000Z'),
    });

    expect(nextRunAt.toISOString()).toBe('2024-01-01T12:15:00.000Z');
  });

  it('finds the next daily slot after a year-long gap across DST changes', async () => {
    // Due 2023-01-01 09:00 America/New_York, picked up 2024-07-04 08:59 EDT.
    const nextRunAt = await reserveLate('2024-07-04T12:59:00.000Z', {
      cadence: 'DAILY',
      scheduledTime: '09:00',
      timezone: 'America/New_York',
      scheduledDayOfMonth: null,
      dueAt: new Date('2023-01-01T14:00:00.000Z'),
    });

    expect(nextRunAt.toISOString()).toBe('2024-07-04T13:00:00.000Z');
  });
});

describe('periodicTaskAccessor.findDueTasks', () => {
  it('selects only enabled tasks in active projects whose next run has arrived', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-05-20T12:00:00Z');
    vi.setSystemTime(now);
    prismaMock.periodicTask.findMany.mockResolvedValue([]);
    try {
      await expect(periodicTaskAccessor.findDueTasks()).resolves.toEqual([]);
      expect(prismaMock.periodicTask.findMany).toHaveBeenCalledExactlyOnceWith({
        where: { isEnabled: true, nextRunAt: { lte: now }, project: { isArchived: false } },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
