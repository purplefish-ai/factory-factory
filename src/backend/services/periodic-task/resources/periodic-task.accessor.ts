import type { PeriodicTask, PeriodicTaskExecution } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import type { PeriodicTaskCadence, PeriodicTaskExecutionStatus } from '@/shared/core';

// ─── Cadence helpers ────────────────────────────────────────────────────────

const LONG_CADENCES = new Set<PeriodicTaskCadence>(['DAILY', 'WEEKLY', 'MONTHLY']);
const MIN_TIMEZONE_OFFSET_MINUTES = -14 * 60;
const MAX_TIMEZONE_OFFSET_MINUTES = 12 * 60;

type TimeZoneDateParts = { year: number; month: number; day: number };
type TimeZoneDateTimeParts = TimeZoneDateParts & { hour: number; minute: number };
type ScheduledTimeParts = { hours: number; minutes: number };

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

/**
 * When a task has a scheduledTime + timezone, snap the computed next date to
 * that clock time in the user's timezone.
 */
function applyScheduledTime(date: Date, scheduledTime: string, timezone: string): Date {
  return dateFromTimeZoneDateTime(
    getTimeZoneDateParts(date, timezone),
    parseScheduledTime(scheduledTime),
    timezone
  );
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
    return null;
  }

  return existingDay ?? getDayOfMonth(anchorDate, timezone);
}

function computeNextRunAt(
  cadence: PeriodicTaskCadence,
  from: Date = new Date(),
  scheduledTime?: string | null,
  timezone?: string | null,
  scheduledDayOfMonth?: number | null
): Date {
  const next = new Date(from);
  switch (cadence) {
    case 'EVERY_MINUTE':
      next.setMinutes(next.getMinutes() + 1);
      break;
    case 'EVERY_FIVE_MINUTES':
      next.setMinutes(next.getMinutes() + 5);
      break;
    case 'DAILY':
      next.setDate(next.getDate() + 1);
      break;
    case 'WEEKLY':
      next.setDate(next.getDate() + 7);
      break;
    case 'MONTHLY': {
      if (scheduledTime && timezone) {
        const fromParts = getTimeZoneDateParts(from, timezone);
        const targetYear = fromParts.month === 12 ? fromParts.year + 1 : fromParts.year;
        const targetMonth = fromParts.month === 12 ? 1 : fromParts.month + 1;
        const targetDay = Math.min(
          scheduledDayOfMonth ?? fromParts.day,
          daysInMonth(targetYear, targetMonth)
        );

        return dateFromTimeZoneDateTime(
          { year: targetYear, month: targetMonth, day: targetDay },
          parseScheduledTime(scheduledTime),
          timezone
        );
      }

      const targetMonth = next.getMonth() + 1;
      next.setDate(1); // Avoid overflow when advancing month
      next.setMonth(targetMonth);
      const targetDay = scheduledDayOfMonth ?? getDayOfMonth(from, timezone);
      const lastDay = daysInMonth(next.getFullYear(), next.getMonth() + 1);
      next.setDate(Math.min(targetDay, lastDay));
      break;
    }
  }

  if (scheduledTime && timezone && LONG_CADENCES.has(cadence)) {
    return applyScheduledTime(next, scheduledTime, timezone);
  }

  return next;
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
        scheduledDayOfMonth,
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
      const scheduledDayOfMonth = resolveScheduledDayOfMonth(
        task.cadence as PeriodicTaskCadence,
        task.scheduledDayOfMonth,
        task.timezone,
        task.createdAt
      );
      data.scheduledDayOfMonth = scheduledDayOfMonth;
      data.nextRunAt = computeNextRunAt(
        task.cadence as PeriodicTaskCadence,
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
      },
    });
  },

  async markDispatched(
    id: string,
    cadence: PeriodicTaskCadence,
    scheduledTime: string | null,
    timezone: string | null,
    scheduledDayOfMonth: number | null
  ): Promise<void> {
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

    await prisma.periodicTask.update({
      where: { id },
      data: {
        lastRunAt: new Date(),
        scheduledDayOfMonth: resolvedScheduledDayOfMonth,
        nextRunAt: computeNextRunAt(
          cadence,
          new Date(),
          scheduledTime,
          timezone,
          resolvedScheduledDayOfMonth
        ),
      },
    });
  },

  // ─── Execution CRUD ─────────────────────────────────────────────────────

  async createExecution(input: {
    periodicTaskId: string;
    workspaceId: string;
    status: PeriodicTaskExecutionStatus;
  }): Promise<PeriodicTaskExecution> {
    return await prisma.periodicTaskExecution.create({
      data: {
        periodicTaskId: input.periodicTaskId,
        workspaceId: input.workspaceId,
        status: input.status,
      },
    });
  },

  async updateExecution(
    id: string,
    data: {
      status?: PeriodicTaskExecutionStatus;
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
