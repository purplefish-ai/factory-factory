import type { PeriodicTask, PeriodicTaskExecution } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import { computeNextCadenceRunAt, getDayOfMonth } from '@/backend/lib/cadence-schedule';
import type { PeriodicTaskCadence, PeriodicTaskExecutionStatus } from '@/shared/core';

// ─── Cadence helpers ────────────────────────────────────────────────────────

type PeriodicTaskDispatchSchedule = {
  cadence: PeriodicTaskCadence;
  scheduledTime: string | null;
  timezone: string | null;
  scheduledDayOfMonth: number | null;
};

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

const computeNextRunAt = computeNextCadenceRunAt;

async function buildDispatchedTaskData(
  id: string,
  { cadence, scheduledTime, timezone, scheduledDayOfMonth }: PeriodicTaskDispatchSchedule
): Promise<{
  lastRunAt: Date;
  scheduledDayOfMonth: number | null;
  nextRunAt: Date;
}> {
  const dispatchedAt = new Date();
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
      task?.createdAt ?? dispatchedAt
    );
  }

  return {
    lastRunAt: dispatchedAt,
    scheduledDayOfMonth: resolvedScheduledDayOfMonth,
    nextRunAt: computeNextRunAt(
      cadence,
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
