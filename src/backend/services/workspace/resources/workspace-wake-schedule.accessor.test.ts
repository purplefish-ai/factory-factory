import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindUnique = vi.fn();
const mockUpsert = vi.fn();
const mockDeleteMany = vi.fn();
const mockFindMany = vi.fn();
const mockUpdateMany = vi.fn();

vi.mock('@/backend/db', () => ({
  prisma: {
    workspaceWakeSchedule: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    },
  },
}));

import {
  flattenWorkspaceWakeSchedule,
  WORKSPACE_WAKE_SCHEDULE_DEFAULTS,
  workspaceWakeScheduleAccessor,
} from './workspace-wake-schedule.accessor';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('flattenWorkspaceWakeSchedule', () => {
  it('maps the row onto the wakeSchedule* read names', () => {
    const nextWakeAt = new Date('2026-05-20T12:00:00.000Z');
    expect(
      flattenWorkspaceWakeSchedule({
        workspaceId: 'ws-1',
        enabled: true,
        cadence: 'EVERY_HOUR',
        prompt: 'Check the logs',
        scheduledTime: null,
        timezone: null,
        scheduledDayOfMonth: null,
        nextWakeAt,
        lastWakeAt: null,
        lastOutcome: null,
        lastError: null,
      })
    ).toEqual({
      wakeScheduleEnabled: true,
      wakeScheduleCadence: 'EVERY_HOUR',
      wakeScheduleNextWakeAt: nextWakeAt,
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('reads as no-schedule when the row is %s', (_label, missing) => {
    expect(flattenWorkspaceWakeSchedule(missing)).toEqual(WORKSPACE_WAKE_SCHEDULE_DEFAULTS);
  });
});

describe('workspaceWakeScheduleAccessor.getByWorkspaceId', () => {
  it('reads the row by workspace id', async () => {
    mockFindUnique.mockResolvedValue({ workspaceId: 'ws-1' });
    const result = await workspaceWakeScheduleAccessor.getByWorkspaceId('ws-1');
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { workspaceId: 'ws-1' } });
    expect(result).toEqual({ workspaceId: 'ws-1' });
  });
});

describe('workspaceWakeScheduleAccessor.upsert', () => {
  it('computes nextWakeAt and resets outcome fields on create and replace', async () => {
    mockUpsert.mockResolvedValue({});
    await workspaceWakeScheduleAccessor.upsert('ws-1', {
      cadence: 'DAILY',
      prompt: 'Check the logs',
    });

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const call = mockUpsert.mock.calls[0]![0];
    expect(call.where).toEqual({ workspaceId: 'ws-1' });
    expect(call.create).toMatchObject({
      workspaceId: 'ws-1',
      enabled: true,
      cadence: 'DAILY',
      prompt: 'Check the logs',
      lastOutcome: null,
      lastError: null,
    });
    expect(call.create.nextWakeAt).toBeInstanceOf(Date);
    expect(call.update).toMatchObject({ enabled: true, cadence: 'DAILY' });
  });

  it('resolves scheduledDayOfMonth for MONTHLY cadence', async () => {
    mockUpsert.mockResolvedValue({});
    const now = new Date('2026-03-15T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    await workspaceWakeScheduleAccessor.upsert('ws-1', {
      cadence: 'MONTHLY',
      prompt: 'Monthly check',
      timezone: 'UTC',
    });

    const call = mockUpsert.mock.calls[0]![0];
    expect(call.create.scheduledDayOfMonth).toBe(15);

    vi.useRealTimers();
  });
});

describe('workspaceWakeScheduleAccessor.clear', () => {
  it('deletes the row for the workspace', async () => {
    mockDeleteMany.mockResolvedValue({ count: 1 });
    await workspaceWakeScheduleAccessor.clear('ws-1');
    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { workspaceId: 'ws-1' } });
  });
});

describe('workspaceWakeScheduleAccessor.findDue', () => {
  it('queries enabled, due schedules on live workspaces', async () => {
    mockFindMany.mockResolvedValue([]);
    await workspaceWakeScheduleAccessor.findDue();

    const call = mockFindMany.mock.calls[0]![0];
    expect(call.where.enabled).toBe(true);
    expect(call.where.nextWakeAt.lte).toBeInstanceOf(Date);
    expect(call.where.workspace).toEqual({ status: { notIn: ['ARCHIVED', 'ARCHIVING'] } });
  });
});

describe('workspaceWakeScheduleAccessor.markDispatched', () => {
  const schedule = {
    workspaceId: 'ws-1',
    enabled: true,
    cadence: 'DAILY' as const,
    prompt: 'Check logs',
    scheduledTime: null,
    timezone: null,
    scheduledDayOfMonth: null,
    nextWakeAt: new Date('2026-05-20T12:00:00.000Z'),
    lastWakeAt: null,
    lastOutcome: null,
    lastError: null,
  };

  it('atomically claims the schedule and advances nextWakeAt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(schedule.nextWakeAt);
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const claimed = await workspaceWakeScheduleAccessor.markDispatched(schedule);

    expect(claimed).toBe(true);
    const call = mockUpdateMany.mock.calls[0]![0];
    expect(call.where).toEqual({
      workspaceId: 'ws-1',
      enabled: true,
      nextWakeAt: schedule.nextWakeAt,
    });
    // DAILY cadence from the claim moment: exactly one day later.
    expect(call.data.nextWakeAt).toEqual(new Date('2026-05-21T12:00:00.000Z'));

    vi.useRealTimers();
  });

  it('returns false when another poll cycle already claimed it', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    const claimed = await workspaceWakeScheduleAccessor.markDispatched(schedule);
    expect(claimed).toBe(false);
  });
});

describe('workspaceWakeScheduleAccessor.recordOutcome', () => {
  it('stores the outcome and clears the error when none given', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });
    await workspaceWakeScheduleAccessor.recordOutcome('ws-1', { outcome: 'DELIVERED' });
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1' },
      data: { lastOutcome: 'DELIVERED', lastError: null },
    });
  });

  it('stores the error message on failure', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });
    await workspaceWakeScheduleAccessor.recordOutcome('ws-1', {
      outcome: 'FAILED',
      error: 'boom',
    });
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1' },
      data: { lastOutcome: 'FAILED', lastError: 'boom' },
    });
  });
});
