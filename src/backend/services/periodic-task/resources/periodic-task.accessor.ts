import type { PeriodicTask, PeriodicTaskExecution } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import type { PeriodicTaskCadence, PeriodicTaskExecutionStatus } from '@/shared/core';

// ─── Cadence helpers ────────────────────────────────────────────────────────

const LONG_CADENCES = new Set<PeriodicTaskCadence>(['DAILY', 'WEEKLY', 'MONTHLY']);

function getTimeZoneDateParts(
  date: Date,
  timezone: string
): { year: number; month: number; day: number } {
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

function toDateString(parts: { year: number; month: number; day: number }): string {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(
    2,
    '0'
  )}`;
}

function parseScheduledTime(scheduledTime: string): { hours: number; minutes: number } {
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
  dateParts: { year: number; month: number; day: number },
  timeParts: { hours: number; minutes: number },
  timezone: string
): Date {
  // Build a UTC probe: treat the target local datetime as if it were UTC.
  const utcProbe = new Date(
    Date.UTC(
      dateParts.year,
      dateParts.month - 1,
      dateParts.day,
      timeParts.hours,
      timeParts.minutes,
      0
    )
  );

  // Find what hour/minute utcProbe shows in the target timezone so we can
  // compute the offset and correct back to true UTC.
  const localTimeParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(utcProbe)
      .map(({ type, value }) => [type, value])
  );

  const probeHour = Number(localTimeParts.hour) % 24; // guard against "24" at midnight
  const probeMinute = Number(localTimeParts.minute);

  let offsetMinutes = (timeParts.hours - probeHour) * 60 + (timeParts.minutes - probeMinute);
  // offsetMinutes is the negation of the timezone offset, so valid range is
  // [-14h, +12h] (i.e. UTC+14 → −840 min, UTC−12 → +720 min).
  if (offsetMinutes < -14 * 60) {
    offsetMinutes += 24 * 60;
  }
  if (offsetMinutes > 12 * 60) {
    offsetMinutes -= 24 * 60;
  }
  const offsetMs = offsetMinutes * 60_000;

  const candidate = new Date(utcProbe.getTime() + offsetMs);

  // Validate the candidate's calendar day in the target timezone matches the
  // intended day. Ambiguous offset boundaries (e.g. UTC-10 at morning hours
  // where offsetMinutes lands exactly on -840) can cause an off-by-one-day
  // error; correct by ±24h if needed.
  const candidateParts = getTimeZoneDateParts(candidate, timezone);

  const intendedDate = toDateString(dateParts);
  const candidateDate = toDateString(candidateParts);

  if (candidateDate < intendedDate) {
    return new Date(candidate.getTime() + 24 * 60 * 60_000);
  }
  if (candidateDate > intendedDate) {
    return new Date(candidate.getTime() - 24 * 60 * 60_000);
  }

  return candidate;
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

function computeNextRunAt(
  cadence: PeriodicTaskCadence,
  from: Date = new Date(),
  scheduledTime?: string | null,
  timezone?: string | null
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
        const targetDay = Math.min(fromParts.day, daysInMonth(targetYear, targetMonth));

        return dateFromTimeZoneDateTime(
          { year: targetYear, month: targetMonth, day: targetDay },
          parseScheduledTime(scheduledTime),
          timezone
        );
      }

      const targetMonth = next.getMonth() + 1;
      next.setDate(1); // Avoid overflow when advancing month
      next.setMonth(targetMonth);
      // Clamp to the last day of the target month if the original day exceeds it
      const lastDay = daysInMonth(next.getFullYear(), next.getMonth() + 1);
      next.setDate(Math.min(from.getDate(), lastDay));
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
    return await prisma.periodicTask.create({
      data: {
        projectId: input.projectId,
        name: input.name,
        prompt: input.prompt,
        cadence: input.cadence,
        scheduledTime: input.scheduledTime ?? null,
        timezone: input.timezone ?? null,
        nextRunAt: new Date(), // Run immediately for first execution
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
    if (input.name !== undefined) {
      data.name = input.name;
    }
    if (input.prompt !== undefined) {
      data.prompt = input.prompt;
    }
    if (input.isEnabled !== undefined) {
      data.isEnabled = input.isEnabled;
    }

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

      Object.assign(data, {
        ...(input.cadence !== undefined && { cadence: input.cadence }),
        ...(input.scheduledTime !== undefined && { scheduledTime: input.scheduledTime }),
        ...(input.timezone !== undefined && { timezone: input.timezone }),
        nextRunAt: computeNextRunAt(cadence, new Date(), scheduledTime, timezone),
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
      data.nextRunAt = computeNextRunAt(
        task.cadence as PeriodicTaskCadence,
        new Date(),
        task.scheduledTime,
        task.timezone
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
    timezone: string | null
  ): Promise<void> {
    await prisma.periodicTask.update({
      where: { id },
      data: {
        lastRunAt: new Date(),
        nextRunAt: computeNextRunAt(cadence, new Date(), scheduledTime, timezone),
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
