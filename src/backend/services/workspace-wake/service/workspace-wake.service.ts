/**
 * Workspace Wake Service
 *
 * Polling loop that finds workspaces with a due, enabled wake schedule and
 * resumes each one's own session with its stored prompt — unlike Periodic
 * Tasks, which spawns a brand-new workspace per run, this preserves the
 * workspace's existing conversation.
 */

import type { WorkspaceWakeSchedule } from '@prisma-gen/client';
import { toError } from '@/backend/lib/error-utils';
import { SERVICE_INTERVAL_MS } from '@/backend/services/constants';
import { jobRunner } from '@/backend/services/job-runner.service';
import type { createLogger } from '@/backend/services/logger.service';
import type { PeriodicTaskCadence } from '@/shared/core';

type Logger = ReturnType<typeof createLogger>;

export interface SetWakeScheduleInput {
  cadence: PeriodicTaskCadence;
  prompt: string;
  scheduledTime?: string | null;
  timezone?: string | null;
}

export type WakeOutcome = 'DELIVERED' | 'FAILED' | 'SKIPPED_NO_SESSION';

/** Bridge for the `WorkspaceWakeSchedule` row — wired to the workspace capsule. */
export interface WorkspaceWakeScheduleBridge {
  get(workspaceId: string): Promise<WorkspaceWakeSchedule | null>;
  set(workspaceId: string, input: SetWakeScheduleInput): Promise<WorkspaceWakeSchedule>;
  clear(workspaceId: string): Promise<void>;
  findDue(): Promise<WorkspaceWakeSchedule[]>;
  markDispatched(schedule: WorkspaceWakeSchedule): Promise<Date | null>;
  recordOutcome(
    workspaceId: string,
    dispatchedAt: Date,
    outcome: { outcome: WakeOutcome; error?: string | null }
  ): Promise<void>;
}

/** Bridge for resuming a workspace's own session with a prompt. */
export interface WorkspaceWakeDeliveryBridge {
  deliver(workspaceId: string, prompt: string): Promise<{ delivered: boolean }>;
}

const WORKSPACE_WAKE_POLL_JOB = 'workspace-wake-poll';

export class WorkspaceWakeService {
  private scheduleBridge: WorkspaceWakeScheduleBridge | null = null;
  private deliveryBridge: WorkspaceWakeDeliveryBridge | null = null;
  // Deliveries are detached from the poll cycle (see dispatchWake) so shutdown
  // can't observe them through jobRunner.stop() alone; tracked here so stop()
  // can wait for them instead of letting the database disconnect mid-write.
  private readonly inFlightDeliveries = new Set<Promise<void>>();

  constructor(private readonly logger: Logger) {
    jobRunner.register({
      name: WORKSPACE_WAKE_POLL_JOB,
      intervalMs: SERVICE_INTERVAL_MS.workspaceWakePoll,
      runImmediately: true,
      run: (signal) => this.runCycle(signal),
    });
  }

  configure(bridges: {
    schedule: WorkspaceWakeScheduleBridge;
    delivery: WorkspaceWakeDeliveryBridge;
  }): void {
    this.scheduleBridge = bridges.schedule;
    this.deliveryBridge = bridges.delivery;
  }

  get(workspaceId: string): Promise<WorkspaceWakeSchedule | null> {
    return this.requireScheduleBridge().get(workspaceId);
  }

  set(workspaceId: string, input: SetWakeScheduleInput): Promise<WorkspaceWakeSchedule> {
    return this.requireScheduleBridge().set(workspaceId, input);
  }

  clear(workspaceId: string): Promise<void> {
    return this.requireScheduleBridge().clear(workspaceId);
  }

  start(): void {
    jobRunner.start(WORKSPACE_WAKE_POLL_JOB);
  }

  async stop(): Promise<void> {
    await jobRunner.stop(WORKSPACE_WAKE_POLL_JOB);
    await Promise.allSettled(this.inFlightDeliveries);
  }

  private requireScheduleBridge(): WorkspaceWakeScheduleBridge {
    if (!this.scheduleBridge) {
      throw new Error('WorkspaceWakeService not configured');
    }
    return this.scheduleBridge;
  }

  // ─── Main loop ──────────────────────────────────────────────────────────

  private async runCycle(signal: AbortSignal): Promise<void> {
    if (!(this.scheduleBridge && this.deliveryBridge)) {
      this.logger.warn('Workspace wake service not configured — skipping poll');
      return;
    }

    try {
      const due = await this.scheduleBridge.findDue();
      for (const schedule of due) {
        if (signal.aborted) {
          break;
        }
        await this.dispatchWake(schedule);
      }
    } catch (error) {
      this.logger.error('Workspace wake poll error', toError(error));
    }
  }

  private async dispatchWake(schedule: WorkspaceWakeSchedule): Promise<void> {
    const scheduleBridge = this.requireScheduleBridge();
    const deliveryBridge = this.deliveryBridge;
    if (!deliveryBridge) {
      return;
    }

    const dispatchedAt = await scheduleBridge.markDispatched(schedule);
    if (!dispatchedAt) {
      // Another poll cycle already claimed this schedule's current occurrence.
      return;
    }

    this.logger.info('Dispatching workspace wake', { workspaceId: schedule.workspaceId });

    // A wake turn can run for a long time (it resumes a full agent turn), so
    // it must not block the poll cycle from reaching other due workspaces.
    // Same detached-dispatch reasoning as
    // `workspace-wake-delivery.orchestrator.ts`/`workspace-notification-delivery.orchestrator.ts`.
    const delivery = deliveryBridge
      .deliver(schedule.workspaceId, schedule.prompt)
      .then((result) =>
        scheduleBridge.recordOutcome(schedule.workspaceId, dispatchedAt, {
          outcome: result.delivered ? 'DELIVERED' : 'SKIPPED_NO_SESSION',
        })
      )
      .catch((error) => {
        this.logger.error('Workspace wake delivery failed', toError(error), {
          workspaceId: schedule.workspaceId,
        });
        return scheduleBridge
          .recordOutcome(schedule.workspaceId, dispatchedAt, {
            outcome: 'FAILED',
            error: toError(error).message,
          })
          .catch((outcomeError) => {
            this.logger.error('Failed to record workspace wake outcome', toError(outcomeError), {
              workspaceId: schedule.workspaceId,
            });
          });
      });
    this.inFlightDeliveries.add(delivery);
    void delivery.finally(() => {
      this.inFlightDeliveries.delete(delivery);
    });
  }
}
