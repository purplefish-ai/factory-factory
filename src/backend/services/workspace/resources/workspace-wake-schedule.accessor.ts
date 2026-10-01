import type { WorkspaceWakeSchedule } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import { computeNextCadenceRunAt, getDayOfMonth } from '@/backend/lib/cadence-schedule';
import type { PeriodicTaskCadence } from '@/shared/core';

/**
 * Persistence for `WorkspaceWakeSchedule`, the sole writer of that table.
 *
 * Unlike `WorkspaceRatchet`/`WorkspaceAutoIteration`, no row is created with
 * the workspace: it exists only once the agent has set a schedule for itself,
 * so "no row" and "no schedule" are the same thing — there is nothing to
 * flatten onto every workspace read.
 */

export interface SetWakeScheduleInput {
  cadence: PeriodicTaskCadence;
  prompt: string;
  scheduledTime?: string | null;
  timezone?: string | null;
}

/**
 * The wake-schedule fields flattened onto workspace reads, for the kanban
 * badge and right panel. Only the display subset — the full row is read via
 * `workspaceWake.get` where needed.
 */
export interface WorkspaceWakeScheduleFields {
  wakeScheduleEnabled: boolean;
  wakeScheduleCadence: PeriodicTaskCadence | null;
  wakeScheduleNextWakeAt: Date | null;
}

/** The persisted row, as joined onto a workspace read. */
export type WorkspaceWakeScheduleRow = WorkspaceWakeSchedule;

/** What a workspace with no wake-schedule row reads as: no schedule. */
export const WORKSPACE_WAKE_SCHEDULE_DEFAULTS: WorkspaceWakeScheduleFields = {
  wakeScheduleEnabled: false,
  wakeScheduleCadence: null,
  wakeScheduleNextWakeAt: null,
};

export function flattenWorkspaceWakeSchedule(
  wakeSchedule: WorkspaceWakeSchedule | null | undefined
): WorkspaceWakeScheduleFields {
  if (!wakeSchedule) {
    return { ...WORKSPACE_WAKE_SCHEDULE_DEFAULTS };
  }
  return {
    wakeScheduleEnabled: wakeSchedule.enabled,
    wakeScheduleCadence: wakeSchedule.cadence,
    wakeScheduleNextWakeAt: wakeSchedule.nextWakeAt,
  };
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

class WorkspaceWakeScheduleAccessor {
  async getByWorkspaceId(workspaceId: string): Promise<WorkspaceWakeSchedule | null> {
    return await prisma.workspaceWakeSchedule.findUnique({ where: { workspaceId } });
  }

  /** Create or fully replace the workspace's wake schedule. */
  async upsert(workspaceId: string, input: SetWakeScheduleInput): Promise<WorkspaceWakeSchedule> {
    const now = new Date();
    const scheduledDayOfMonth =
      input.cadence === 'MONTHLY' ? getDayOfMonth(now, input.timezone) : null;
    const nextWakeAt = computeNextCadenceRunAt(
      input.cadence,
      now,
      input.scheduledTime,
      input.timezone,
      scheduledDayOfMonth
    );

    const data = {
      enabled: true,
      cadence: input.cadence,
      prompt: input.prompt,
      scheduledTime: input.scheduledTime ?? null,
      timezone: input.timezone ?? null,
      scheduledDayOfMonth,
      nextWakeAt,
      lastOutcome: null,
      lastError: null,
    };

    return await prisma.workspaceWakeSchedule.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data },
      update: data,
    });
  }

  async clear(workspaceId: string): Promise<void> {
    await prisma.workspaceWakeSchedule.deleteMany({ where: { workspaceId } });
  }

  /** Enabled schedules that are due, on workspaces that are still live. */
  async findDue(): Promise<WorkspaceWakeSchedule[]> {
    return await prisma.workspaceWakeSchedule.findMany({
      where: {
        enabled: true,
        nextWakeAt: { lte: new Date() },
        workspace: { status: { notIn: ['ARCHIVED', 'ARCHIVING'] } },
      },
    });
  }

  /**
   * Atomically claim a due schedule and advance it to its next occurrence, so
   * two overlapping poll cycles cannot both dispatch the same wake. Returns
   * the claim's `dispatchedAt` as an occurrence token: callers pass it back to
   * `recordOutcome` so a slow, superseded delivery can't overwrite a later
   * occurrence's outcome.
   */
  async markDispatched(schedule: WorkspaceWakeSchedule): Promise<Date | null> {
    const dispatchedAt = new Date();
    let resolvedScheduledDayOfMonth = schedule.scheduledDayOfMonth;
    if (schedule.cadence === 'MONTHLY' && resolvedScheduledDayOfMonth == null) {
      resolvedScheduledDayOfMonth = resolveScheduledDayOfMonth(
        schedule.cadence,
        schedule.scheduledDayOfMonth,
        schedule.timezone,
        dispatchedAt
      );
    }

    const nextWakeAt = computeNextCadenceRunAt(
      schedule.cadence,
      dispatchedAt,
      schedule.scheduledTime,
      schedule.timezone,
      resolvedScheduledDayOfMonth
    );

    const result = await prisma.workspaceWakeSchedule.updateMany({
      where: { workspaceId: schedule.workspaceId, enabled: true, nextWakeAt: schedule.nextWakeAt },
      data: {
        lastWakeAt: dispatchedAt,
        nextWakeAt,
        scheduledDayOfMonth: resolvedScheduledDayOfMonth,
      },
    });
    return result.count > 0 ? dispatchedAt : null;
  }

  /**
   * Records a delivery outcome, but only if `dispatchedAt` still matches the
   * row's `lastWakeAt` — the occurrence token from the `markDispatched` claim
   * that triggered this delivery. If a later occurrence has already been
   * claimed (and so advanced `lastWakeAt`), this is a no-op, so a slow,
   * superseded delivery cannot clobber the newer occurrence's outcome.
   */
  async recordOutcome(
    workspaceId: string,
    dispatchedAt: Date,
    outcome: { outcome: 'DELIVERED' | 'FAILED' | 'SKIPPED_NO_SESSION'; error?: string | null }
  ): Promise<void> {
    await prisma.workspaceWakeSchedule.updateMany({
      where: { workspaceId, lastWakeAt: dispatchedAt },
      data: { lastOutcome: outcome.outcome, lastError: outcome.error ?? null },
    });
  }
}

export const workspaceWakeScheduleAccessor = new WorkspaceWakeScheduleAccessor();
