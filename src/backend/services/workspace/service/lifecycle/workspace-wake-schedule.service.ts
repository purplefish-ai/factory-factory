import type { WorkspaceWakeSchedule } from '@prisma-gen/client';
import {
  type SetWakeScheduleInput,
  workspaceWakeScheduleAccessor,
} from '@/backend/services/workspace/resources/workspace-wake-schedule.accessor';

/**
 * The workspace capsule's public surface for the `WorkspaceWakeSchedule` row,
 * used by the `workspace-wake` capsule and the tRPC router through the barrel.
 *
 * Every method delegates to `workspaceWakeScheduleAccessor`, the sole writer.
 */
class WorkspaceWakeScheduleService {
  get(workspaceId: string): Promise<WorkspaceWakeSchedule | null> {
    return workspaceWakeScheduleAccessor.getByWorkspaceId(workspaceId);
  }

  set(workspaceId: string, input: SetWakeScheduleInput): Promise<WorkspaceWakeSchedule> {
    return workspaceWakeScheduleAccessor.upsert(workspaceId, input);
  }

  clear(workspaceId: string): Promise<void> {
    return workspaceWakeScheduleAccessor.clear(workspaceId);
  }

  findDue(): Promise<WorkspaceWakeSchedule[]> {
    return workspaceWakeScheduleAccessor.findDue();
  }

  markDispatched(schedule: WorkspaceWakeSchedule): Promise<boolean> {
    return workspaceWakeScheduleAccessor.markDispatched(schedule);
  }

  recordOutcome(
    workspaceId: string,
    outcome: { outcome: 'DELIVERED' | 'FAILED' | 'SKIPPED_NO_SESSION'; error?: string | null }
  ): Promise<void> {
    return workspaceWakeScheduleAccessor.recordOutcome(workspaceId, outcome);
  }
}

export const workspaceWakeScheduleService = new WorkspaceWakeScheduleService();
