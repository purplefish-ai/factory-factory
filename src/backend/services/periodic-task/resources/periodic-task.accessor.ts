import { z } from 'zod';
import { prisma } from '@/backend/db';
import type { PeriodicTaskCadence, PeriodicTaskExecutionStatus } from '@/shared/core';
import type { PeriodicTask, PeriodicTaskExecution } from '@prisma-gen/client';

// ─── Cadence helpers ────────────────────────────────────────────────────────

const MIN_TIMEZONE_OFFSET_MINUTES = -14 * 60;
const MAX_TIMEZONE_OFFSET_MINUTES = 12 * 60;

type TimeZoneDateParts = { year: number; month: number; day: number };
type TimeZoneDateTimeParts = TimeZoneDateParts & { hour: number; minute: number };
type ScheduledTimeParts = { hours: number; minutes: number };
type PeriodicTaskDispatchSchedule = {
  cadence: PeriodicTaskCadence;
  scheduledTime: string | null;
  timezone: string | null;
  scheduledDayOfMonth: number | null;
  /** The task's `nextRunAt` when it was found due: the slot being dispatched. */
  dueAt: Date;
};

function getTimeZoneDateParts(date: Date, timezone: string): TimeZoneDateParts {
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

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function getTimeZoneDateTimeParts(
  date: Date,
  formatter: Intl.DateTimeFormat
): TimeZoneDateTimeParts {
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(({ type, value }) => [type, value])
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

function parseScheduledTime(scheduledTime: string): ScheduledTimeParts {
  const parts = scheduledTime.split(':').map(Number);
  return {
    hours: parts[0] ?? 0,
    minutes: parts[1] ?? 0,
  };
}

function getTimeZoneTimeParts(date: Date, timezone: string): ScheduledTimeParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value])
  );

  return {
    hours: Number(parts.hour) % 24,
    minutes: Number(parts.minute),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Convert an intended local datetime in the user's timezone to UTC.
 * Uses the Intl API — no extra deps.
 */
function dateFromTimeZoneDateTime(
  dateParts: TimeZoneDateParts,
  timeParts: ScheduledTimeParts,
  timezone: string
): Date {
  const utcProbeMs = Date.UTC(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    timeParts.hours,
    timeParts.minutes,
    0
  );
  const dateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  for (
    let offsetMinutes = MIN_TIMEZONE_OFFSET_MINUTES;
    offsetMinutes <= MAX_TIMEZONE_OFFSET_MINUTES;
    offsetMinutes += 1
  ) {
    const candidate = new Date(utcProbeMs + offsetMinutes * 60_000);
    const candidateParts = getTimeZoneDateTimeParts(candidate, dateTimeFormatter);

    if (
      candidateParts.year === dateParts.year &&
      candidateParts.month === dateParts.month &&
      candidateParts.day === dateParts.day &&
      candidateParts.hour === timeParts.hours &&
      candidateParts.minute === timeParts.minutes
    ) {
      return candidate;
    }
  }

  // The requested local wall-clock time can be nonexistent on spring-forward
  // transition days. Run at the first valid later local time on that date.
  for (
    let offsetMinutes = MIN_TIMEZONE_OFFSET_MINUTES;
    offsetMinutes <= MAX_TIMEZONE_OFFSET_MINUTES;
    offsetMinutes += 1
  ) {
    const candidate = new Date(utcProbeMs + offsetMinutes * 60_000);
    const candidateParts = getTimeZoneDateTimeParts(candidate, dateTimeFormatter);
    const candidateClockMinutes = candidateParts.hour * 60 + candidateParts.minute;

    if (
      candidateParts.year === dateParts.year &&
      candidateParts.month === dateParts.month &&
      candidateParts.day === dateParts.day &&
      candidateClockMinutes > timeParts.hours * 60 + timeParts.minutes
    ) {
      return candidate;
    }
  }

  return new Date(utcProbeMs);
}

function computeNextMonthlyRunAtInTimeZone(
  from: Date,
  periods: number,
  scheduledTime: string | null | undefined,
  timezone: string,
  scheduledDayOfMonth: number | null | undefined
): Date {
  const fromParts = getTimeZoneDateParts(from, timezone);
  const targetMonthIndex = fromParts.year * 12 + fromParts.month - 1 + periods;
  const targetYear = Math.floor(targetMonthIndex / 12);
  const targetMonth = (targetMonthIndex % 12) + 1;
  const targetDay = Math.min(
    scheduledDayOfMonth ?? fromParts.day,
    daysInMonth(targetYear, targetMonth)
  );
  const target = dateFromTimeZoneDateTime(
    { year: targetYear, month: targetMonth, day: targetDay },
    scheduledTime ? parseScheduledTime(scheduledTime) : getTimeZoneTimeParts(from, timezone),
    timezone
  );

  if (!scheduledTime) {
    target.setUTCSeconds(from.getUTCSeconds(), from.getUTCMilliseconds());
  }

  return target;
}

function getDayOfMonth(date: Date, timezone?: string | null): number {
  if (!timezone) {
    return date.getDate();
  }

  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    day: 'numeric',
  }).format(date);

  return Number(day);
}

function assignIfDefined<T>(
  data: Record<string, unknown>,
  key: string,
  value: T | undefined
): void {
  if (value !== undefined) {
    data[key] = value;
  }
}

function resolveScheduledDayOfMonth(
  cadence: PeriodicTaskCadence,
  existingDay: number | null | undefined,
  timezone: string | null | undefined,
  anchorDate: Date
): number | null {
  if (cadence !== 'MONTHLY') {
    return existingDay ?? null;
  }

  return existingDay ?? getDayOfMonth(anchorDate, timezone);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Upper bound on the time between two consecutive slots of a cadence. Calendar
 * cadences allow an extra hour for a daylight saving change.
 */
const MAX_PERIOD_MS: Record<PeriodicTaskCadence, number> = {
  EVERY_MINUTE: MINUTE_MS,
  EVERY_FIVE_MINUTES: 5 * MINUTE_MS,
  DAILY: DAY_MS + HOUR_MS,
  WEEKLY: 7 * DAY_MS + HOUR_MS,
  MONTHLY: 31 * DAY_MS + HOUR_MS,
};

/** The slot `periods` whole periods after `from`. */
function advanceRunAt(
  cadence: PeriodicTaskCadence,
  from: Date,
  periods: number,
  scheduledTime?: string | null,
  timezone?: string | null,
  scheduledDayOfMonth?: number | null
): Date {
  if (scheduledTime && timezone && (cadence === 'DAILY' || cadence === 'WEEKLY')) {
    const { year, month, day } = getTimeZoneDateParts(from, timezone);
    // Advance the task's calendar date, independent of server timezone and DST.
    const target = new Date(
      Date.UTC(year, month - 1, day + periods * (cadence === 'DAILY' ? 1 : 7))
    );
    return dateFromTimeZoneDateTime(
      { year: target.getUTCFullYear(), month: target.getUTCMonth() + 1, day: target.getUTCDate() },
      parseScheduledTime(scheduledTime),
      timezone
    );
  }

  const next = new Date(from);
  switch (cadence) {
    case 'EVERY_MINUTE':
    case 'EVERY_FIVE_MINUTES':
      // Elapsed time, so a daylight saving change cannot stretch the interval.
      return new Date(from.getTime() + periods * MAX_PERIOD_MS[cadence]);
    case 'DAILY':
      next.setDate(next.getDate() + periods);
      break;
    case 'WEEKLY':
      next.setDate(next.getDate() + periods * 7);
      break;
    case 'MONTHLY': {
      if (timezone) {
        return computeNextMonthlyRunAtInTimeZone(
          from,
          periods,
          scheduledTime,
          timezone,
          scheduledDayOfMonth
        );
      }

      const targetMonth = next.getMonth() + periods;
      next.setDate(1); // Avoid overflow when advancing month
      next.setMonth(targetMonth);
      const targetDay = scheduledDayOfMonth ?? getDayOfMonth(from, timezone);
      const lastDay = daysInMonth(next.getFullYear(), next.getMonth() + 1);
      next.setDate(Math.min(targetDay, lastDay));
      break;
    }
  }

  return next;
}

function computeNextRunAt(
  cadence: PeriodicTaskCadence,
  from: Date = new Date(),
  scheduledTime?: string | null,
  timezone?: string | null,
  scheduledDayOfMonth?: number | null
): Date {
  return advanceRunAt(cadence, from, 1, scheduledTime, timezone, scheduledDayOfMonth);
}

/**
 * The first slot of the series that continues from `dueAt` which falls after
 * `after`. Consecutive slots are at most `MAX_PERIOD_MS` apart, so jumping by
 * the whole periods that fit in the remaining gap never passes over a slot
 * that is still ahead; a long outage takes a handful of steps, not one per
 * missed slot.
 */
function computeNextRunAfter(
  cadence: PeriodicTaskCadence,
  dueAt: Date,
  after: Date,
  scheduledTime: string | null,
  timezone: string | null,
  scheduledDayOfMonth: number | null
): Date {
  let periods = 1;
  let next = advanceRunAt(cadence, dueAt, periods, scheduledTime, timezone, scheduledDayOfMonth);
  while (next <= after) {
    periods += Math.max(1, Math.floor((after.getTime() - next.getTime()) / MAX_PERIOD_MS[cadence]));
    next = advanceRunAt(cadence, dueAt, periods, scheduledTime, timezone, scheduledDayOfMonth);
  }
  return next;
}

async function buildDispatchedTaskData(
  id: string,
  { cadence, scheduledTime, timezone, scheduledDayOfMonth, dueAt }: PeriodicTaskDispatchSchedule
): Promise<{
  lastRunAt: Date;
  scheduledDayOfMonth: number | null;
  nextRunAt: Date;
}> {
  let resolvedScheduledDayOfMonth = scheduledDayOfMonth;
  if (cadence === 'MONTHLY' && resolvedScheduledDayOfMonth == null) {
    const task = await prisma.periodicTask.findUnique({
      where: { id },
      select: { createdAt: true, scheduledDayOfMonth: true, timezone: true },
    });
    resolvedScheduledDayOfMonth = resolveScheduledDayOfMonth(
      cadence,
      task?.scheduledDayOfMonth,
      task?.timezone ?? timezone,
      task?.createdAt ?? new Date()
    );
  }
  // Captured after the awaited lookup so the next run is always after it.
  const dispatchedAt = new Date();

  // Advance from the slot that was due, not from the (possibly late) dispatch
  // time, so a pickup just past local midnight or the month boundary keeps the
  // following slot. If the task missed more than a full period (e.g. while the
  // machine slept), this single run covers every missed slot and the schedule
  // resumes at the first slot still ahead, which may be later today.
  return {
    lastRunAt: dispatchedAt,
    scheduledDayOfMonth: resolvedScheduledDayOfMonth,
    nextRunAt: computeNextRunAfter(
      cadence,
      dueAt,
      dispatchedAt,
      scheduledTime,
      timezone,
      resolvedScheduledDayOfMonth
    ),
  };
}

// ─── Public types ───────────────────────────────────────────────────────────

interface CreatePeriodicTaskInput {
  projectId: string;
  name: string;
  prompt: string;
  cadence: PeriodicTaskCadence;
  scheduledTime?: string | null;
  timezone?: string | null;
}

interface UpdatePeriodicTaskInput {
  name?: string;
  prompt?: string;
  cadence?: PeriodicTaskCadence;
  isEnabled?: boolean;
  scheduledTime?: string | null;
  timezone?: string | null;
}

type PeriodicTaskWithExecutions = PeriodicTask & {
  executions: PeriodicTaskExecution[];
};

// ─── Accessor ───────────────────────────────────────────────────────────────

export const periodicTaskAccessor = {
  computeNextRunAt,

  async create(input: CreatePeriodicTaskInput): Promise<PeriodicTask> {
    const now = new Date();
    const scheduledDayOfMonth =
      input.cadence === 'MONTHLY' ? getDayOfMonth(now, input.timezone) : null;

    return await prisma.periodicTask.create({
      data: {
        projectId: input.projectId,
        name: input.name,
        prompt: input.prompt,
        cadence: input.cadence,
        scheduledTime: input.scheduledTime ?? null,
        timezone: input.timezone ?? null,
        scheduledDayOfMonth,
        nextRunAt: now, // Run immediately for first execution
      },
    });
  },

  async findById(id: string): Promise<PeriodicTaskWithExecutions | null> {
    return await prisma.periodicTask.findUnique({
      where: { id },
      include: { executions: { orderBy: { startedAt: 'desc' }, take: 20 } },
    });
  },

  async listByProject(projectId: string): Promise<PeriodicTaskWithExecutions[]> {
    return await prisma.periodicTask.findMany({
      where: { projectId },
      include: { executions: { orderBy: { startedAt: 'desc' }, take: 5 } },
      orderBy: { createdAt: 'desc' },
    });
  },

  async getNavigationSummary(projectId: string) {
    // The correlated terminal lookup uses the task index and ignores pending
    // retries before LIMIT, without fetching any execution histories.
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*) AS totalCount,
        COALESCE(SUM((
          SELECT execution.status FROM PeriodicTaskExecution AS execution
          WHERE execution.periodicTaskId = agent.id
            AND execution.status IN ('FAILED', 'PR_CREATED', 'COMPLETED')
          ORDER BY execution.startedAt DESC, execution.id DESC
          LIMIT 1
        ) = 'FAILED'), 0) AS failedCount
      FROM PeriodicTask AS agent
      WHERE agent.projectId = ${projectId}
    `;
    const count = z
      .union([z.bigint(), z.number()])
      .transform(Number)
      .pipe(z.number().int().nonnegative());
    return z.tuple([z.object({ totalCount: count, failedCount: count })]).parse(rows)[0];
  },

  async update(id: string, input: UpdatePeriodicTaskInput): Promise<PeriodicTask> {
    const data: Record<string, unknown> = {};
    assignIfDefined(data, 'name', input.name);
    assignIfDefined(data, 'prompt', input.prompt);
    assignIfDefined(data, 'isEnabled', input.isEnabled);

    const needsNextRunAt =
      input.cadence !== undefined ||
      input.scheduledTime !== undefined ||
      input.timezone !== undefined;

    if (needsNextRunAt) {
      const existing = await prisma.periodicTask.findUniqueOrThrow({ where: { id } });
      const cadence = (input.cadence ?? existing.cadence) as PeriodicTaskCadence;
      const scheduledTime =
        input.scheduledTime !== undefined ? input.scheduledTime : existing.scheduledTime;
      const timezone = input.timezone !== undefined ? input.timezone : existing.timezone;
      const now = new Date();
      const scheduledDayOfMonth = resolveScheduledDayOfMonth(
        cadence,
        existing.scheduledDayOfMonth,
        timezone,
        existing.cadence === 'MONTHLY' ? existing.createdAt : now
      );

      Object.assign(data, {
        ...(input.cadence !== undefined && { cadence: input.cadence }),
        ...(input.scheduledTime !== undefined && { scheduledTime: input.scheduledTime }),
        ...(input.timezone !== undefined && { timezone: input.timezone }),
        ...(cadence === 'MONTHLY' && { scheduledDayOfMonth }),
        nextRunAt: computeNextRunAt(cadence, now, scheduledTime, timezone, scheduledDayOfMonth),
      });
    }

    return await prisma.periodicTask.update({ where: { id }, data });
  },

  async delete(id: string): Promise<void> {
    await prisma.periodicTask.delete({ where: { id } });
  },

  async toggleEnabled(id: string, enabled: boolean): Promise<PeriodicTask> {
    const data: Record<string, unknown> = { isEnabled: enabled };
    if (enabled) {
      const task = await prisma.periodicTask.findUniqueOrThrow({ where: { id } });
      const cadence = task.cadence as PeriodicTaskCadence;
      const scheduledDayOfMonth = resolveScheduledDayOfMonth(
        cadence,
        task.scheduledDayOfMonth,
        task.timezone,
        task.createdAt
      );
      if (cadence === 'MONTHLY') {
        data.scheduledDayOfMonth = scheduledDayOfMonth;
      }
      data.nextRunAt = computeNextRunAt(
        cadence,
        new Date(),
        task.scheduledTime,
        task.timezone,
        scheduledDayOfMonth
      );
    }
    return await prisma.periodicTask.update({ where: { id }, data });
  },

  async findDueTasks(): Promise<PeriodicTask[]> {
    return await prisma.periodicTask.findMany({
      where: {
        isEnabled: true,
        nextRunAt: { lte: new Date() },
        project: { isArchived: false },
      },
    });
  },

  // ─── Execution CRUD ─────────────────────────────────────────────────────

  async reserveExecutionAndMarkDispatched(
    input: {
      periodicTaskId: string;
      workspaceId: string | null;
      status: PeriodicTaskExecutionStatus;
    },
    schedule: PeriodicTaskDispatchSchedule
  ): Promise<PeriodicTaskExecution | null> {
    const data = await buildDispatchedTaskData(input.periodicTaskId, schedule);
    return prisma.$transaction(async (transaction) => {
      const reservation = await transaction.periodicTask.updateMany({
        where: {
          id: input.periodicTaskId,
          isEnabled: true,
          nextRunAt: { lte: data.lastRunAt },
          project: { isArchived: false },
          executions: { none: { status: 'RUNNING' } },
        },
        data,
      });
      if (reservation.count === 0) {
        return null;
      }

      return transaction.periodicTaskExecution.create({
        data: {
          periodicTaskId: input.periodicTaskId,
          workspaceId: input.workspaceId,
          status: input.status,
        },
      });
    });
  },

  async updateExecution(
    id: string,
    data: {
      status?: PeriodicTaskExecutionStatus;
      workspaceId?: string | null;
      prUrl?: string | null;
      prNumber?: number | null;
      errorMessage?: string | null;
      completedAt?: Date | null;
    }
  ): Promise<PeriodicTaskExecution> {
    return await prisma.periodicTaskExecution.update({ where: { id }, data });
  },

  async listExecutions(periodicTaskId: string, limit = 20): Promise<PeriodicTaskExecution[]> {
    return await prisma.periodicTaskExecution.findMany({
      where: { periodicTaskId },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
  },

  async findRunningExecutions(): Promise<
    (PeriodicTaskExecution & { periodicTask: PeriodicTask })[]
  > {
    return await prisma.periodicTaskExecution.findMany({
      where: { status: 'RUNNING' },
      include: { periodicTask: true },
    });
  },

  async hasRunningExecution(periodicTaskId: string): Promise<boolean> {
    const count = await prisma.periodicTaskExecution.count({
      where: { periodicTaskId, status: 'RUNNING' },
    });
    return count > 0;
  },

  async listExecutionsByWorkspacePeriodicTask(
    periodicTaskId: string
  ): Promise<PeriodicTaskExecution[]> {
    return await prisma.periodicTaskExecution.findMany({
      where: { periodicTaskId },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
  },
};
