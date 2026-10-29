/**
 * Periodic Task Service
 *
 * Polling loop that:
 * 1. Finds enabled periodic tasks where nextRunAt <= now
 * 2. Skips tasks that already have a RUNNING execution
 * 3. Reserves an execution, awaits timer dispatch, and links the new workspace
 * 4. Monitors RUNNING executions until the agent finishes
 *
 * A run succeeds when its session finishes cleanly, with or without a PR (an
 * agent that finds nothing to do is still a success). It fails only when the
 * Claude/Codex session itself errors, or the workspace never got set up. The
 * workspace is always left in place for a human to review and clean up.
 */

import { toError } from '@/backend/lib/error-utils';
import { SERVICE_INTERVAL_MS } from '@/backend/services/constants';
import { jobRunner } from '@/backend/services/job-runner.service';
import type { createLogger } from '@/backend/services/logger.service';
import { periodicTaskAccessor } from '@/backend/services/periodic-task/resources/periodic-task.accessor';
import { type PeriodicTaskCadence, WorkspaceStatus } from '@/shared/core';
import type { PeriodicTaskTimerEvent } from './periodic-task-timer-event';

type Logger = ReturnType<typeof createLogger>;

const SCHEDULED_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateScheduleInput(input: {
  scheduledTime?: string | null;
  timezone?: string | null;
}): void {
  if (input.scheduledTime != null && !SCHEDULED_TIME_PATTERN.test(input.scheduledTime)) {
    throw new Error('scheduledTime must use HH:MM in 24-hour time');
  }
  if (input.timezone != null) {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: input.timezone });
    } catch {
      throw new Error(`Invalid IANA timezone: ${input.timezone}`);
    }
  }
}

export const PERIODIC_TASK_READY_WITHOUT_PR_GRACE_MS = 5 * 60_000;
export const PERIODIC_TASK_WORKSPACE_RESERVATION_TIMEOUT_MS = 15 * 60_000;

/** Awaited timer dispatch capability — wired by orchestration after reservation. */
export interface PeriodicTaskTimerDispatchBridge {
  dispatchTimerEvent(event: PeriodicTaskTimerEvent): Promise<{ workspaceId: string }>;
}

/** Bridge for checking workspace PR state. */
export interface PeriodicTaskWorkspaceStatusBridge {
  getWorkspaceStatus(workspaceId: string): Promise<{
    status: WorkspaceStatus;
    prUrl: string | null;
    prNumber: number | null;
    isAgentWorking: boolean;
    initCompletedAt: Date | null;
    /** Latest provider error, timeout, or crash recorded for the workspace's sessions. */
    sessionFailureMessage: string | null;
    /** Whether any agent session in the workspace ever started its provider. */
    hasLaunchedSession: boolean;
  } | null>;
}

/** Job name this service registers with the shared runner. */
const PERIODIC_TASK_POLL_JOB = 'periodic-task-poll';

export class PeriodicTaskService {
  /** The signal of the run currently executing; see `isShuttingDown`. */
  private runSignal: AbortSignal | null = null;
  /** Whether the service itself has been stopped, independent of any run. */
  private stopped = false;

  private timerDispatchBridge: PeriodicTaskTimerDispatchBridge | null = null;
  private statusBridge: PeriodicTaskWorkspaceStatusBridge | null = null;

  constructor(private readonly logger: Logger) {
    jobRunner.register({
      name: PERIODIC_TASK_POLL_JOB,
      intervalMs: SERVICE_INTERVAL_MS.periodicTaskPoll,
      // The loop polled once before its first sleep, and still does.
      runImmediately: true,
      run: (signal) => this.runCycle(signal),
    });
  }

  /**
   * The service's own stopped state, or an abort on the run in flight. See the
   * equivalent in `scheduler.service.ts` for why both are needed.
   */
  private get isShuttingDown(): boolean {
    return this.stopped || (this.runSignal?.aborted ?? false);
  }

  configure(bridges: {
    timerDispatch: PeriodicTaskTimerDispatchBridge;
    status: PeriodicTaskWorkspaceStatusBridge;
  }): void {
    this.timerDispatchBridge = bridges.timerDispatch;
    this.statusBridge = bridges.status;
  }

  list(projectId: string) {
    return periodicTaskAccessor.listByProject(projectId);
  }

  getNavigationSummary(projectId: string) {
    return periodicTaskAccessor.getNavigationSummary(projectId);
  }

  get(id: string) {
    return periodicTaskAccessor.findById(id);
  }

  create(input: Parameters<typeof periodicTaskAccessor.create>[0]) {
    validateScheduleInput(input);
    return periodicTaskAccessor.create(input);
  }

  update(id: string, input: Parameters<typeof periodicTaskAccessor.update>[1]) {
    validateScheduleInput(input);
    return periodicTaskAccessor.update(id, input);
  }

  delete(id: string) {
    return periodicTaskAccessor.delete(id);
  }

  toggleEnabled(id: string, enabled: boolean) {
    return periodicTaskAccessor.toggleEnabled(id, enabled);
  }

  listExecutions(periodicTaskId: string, limit = 20) {
    return periodicTaskAccessor.listExecutions(periodicTaskId, limit);
  }

  listExecutionsByPeriodicTaskId(periodicTaskId: string) {
    return periodicTaskAccessor.listExecutionsByWorkspacePeriodicTask(periodicTaskId);
  }

  start(): void {
    this.stopped = false;
    jobRunner.start(PERIODIC_TASK_POLL_JOB);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await jobRunner.stop(PERIODIC_TASK_POLL_JOB);
  }

  // ─── Main Loop ──────────────────────────────────────────────────────────

  /** One poll cycle: dispatch anything due, then advance running executions. */
  private async runCycle(signal: AbortSignal): Promise<void> {
    this.runSignal = signal;
    try {
      await this.pollDueTasks();
      await this.checkRunningExecutions();
    } catch (error) {
      this.logger.error('Periodic task poll error', toError(error));
    } finally {
      // Scoped to this run; see the note in `scheduler.service.ts`.
      this.runSignal = null;
    }
  }

  // ─── Dispatch due tasks ─────────────────────────────────────────────────

  private async pollDueTasks(): Promise<void> {
    const dueTasks = await periodicTaskAccessor.findDueTasks();
    if (dueTasks.length === 0) {
      return;
    }

    this.logger.info('Found due periodic tasks', { count: dueTasks.length });

    for (const task of dueTasks) {
      if (this.isShuttingDown) {
        break;
      }

      try {
        // Skip if already running
        const running = await periodicTaskAccessor.hasRunningExecution(task.id);
        if (running) {
          this.logger.debug('Skipping periodic task — previous execution still running', {
            taskId: task.id,
            taskName: task.name,
          });
          continue;
        }

        // Once the following reservation attempt begins, shutdown drains it through
        // launch and linkage, including the async monthly-anchor lookup before its
        // transaction. This guard rejects work before that admission boundary.
        if (this.isShuttingDown) {
          break;
        }

        await this.dispatchTask(
          task.id,
          task.projectId,
          task.name,
          task.prompt,
          task.cadence as PeriodicTaskCadence,
          task.scheduledTime,
          task.timezone,
          task.scheduledDayOfMonth
        );
      } catch (error) {
        this.logger.error('Failed to dispatch periodic task', {
          taskId: task.id,
          error: toError(error).message,
        });
      }
    }
  }

  private async dispatchTask(
    taskId: string,
    projectId: string,
    name: string,
    prompt: string,
    cadence: PeriodicTaskCadence,
    scheduledTime: string | null,
    timezone: string | null,
    scheduledDayOfMonth: number | null
  ): Promise<void> {
    if (!this.timerDispatchBridge) {
      this.logger.warn('Periodic task service not configured — skipping dispatch');
      return;
    }

    this.logger.info('Dispatching periodic task', { taskId, name });

    const execution = await periodicTaskAccessor.reserveExecutionAndMarkDispatched(
      {
        periodicTaskId: taskId,
        workspaceId: null,
        status: 'RUNNING',
      },
      {
        cadence,
        scheduledTime,
        timezone,
        scheduledDayOfMonth,
      }
    );
    if (!execution) {
      this.logger.debug('Skipping periodic task — dispatch reservation was already claimed', {
        taskId,
      });
      return;
    }

    let result: { workspaceId: string };
    try {
      result = await this.timerDispatchBridge.dispatchTimerEvent({
        kind: 'timer_due',
        executionId: execution.id,
        projectId,
        name: `${name} — ${new Date().toLocaleDateString()}`,
        prompt,
        periodicTaskId: taskId,
      });
    } catch (error) {
      await this.markReservedExecutionFailed(execution.id, error);
      throw error;
    }

    await periodicTaskAccessor.updateExecution(execution.id, {
      workspaceId: result.workspaceId,
    });

    this.logger.info('Periodic task dispatched', {
      taskId,
      workspaceId: result.workspaceId,
    });
  }

  private async markExecutionFailed(
    executionId: string,
    errorMessage: string,
    context: Record<string, unknown>
  ): Promise<void> {
    await periodicTaskAccessor.updateExecution(executionId, {
      status: 'FAILED',
      errorMessage,
      completedAt: new Date(),
    });
    this.logger.warn('Periodic task execution failed', { executionId, errorMessage, ...context });
  }

  private async markReservedExecutionFailed(executionId: string, error: unknown): Promise<void> {
    try {
      await periodicTaskAccessor.updateExecution(executionId, {
        status: 'FAILED',
        errorMessage: toError(error).message,
        completedAt: new Date(),
      });
    } catch (updateError) {
      this.logger.error('Failed to mark reserved periodic task execution failed', {
        executionId,
        error: toError(updateError).message,
      });
    }
  }

  // ─── Monitor running executions ─────────────────────────────────────────

  private async checkRunningExecutions(): Promise<void> {
    if (!this.statusBridge) {
      return;
    }

    const running = await periodicTaskAccessor.findRunningExecutions();
    for (const execution of running) {
      if (this.isShuttingDown) {
        break;
      }
      await this.checkSingleExecution(execution);
    }
  }

  private async checkSingleExecution(execution: {
    id: string;
    workspaceId: string | null;
    startedAt: Date;
  }): Promise<void> {
    try {
      if (!execution.workspaceId) {
        const reservationAgeMs = Date.now() - execution.startedAt.getTime();
        if (reservationAgeMs >= PERIODIC_TASK_WORKSPACE_RESERVATION_TIMEOUT_MS) {
          await periodicTaskAccessor.updateExecution(execution.id, {
            status: 'FAILED',
            errorMessage: 'Workspace reservation did not link a workspace before timeout',
            completedAt: new Date(),
          });
          this.logger.warn('Periodic task workspace reservation timed out', {
            executionId: execution.id,
            reservationAgeMs,
          });
        }
        return;
      }

      if (!this.statusBridge) {
        return;
      }

      const ws = await this.statusBridge.getWorkspaceStatus(execution.workspaceId);
      if (!ws) {
        return;
      }

      if (ws.prUrl) {
        await periodicTaskAccessor.updateExecution(execution.id, {
          status: 'PR_CREATED',
          prUrl: ws.prUrl,
          prNumber: ws.prNumber,
          completedAt: new Date(),
        });
        this.logger.info('Periodic task execution completed with PR', {
          executionId: execution.id,
          prUrl: ws.prUrl,
        });
        return;
      }

      if (ws.status === WorkspaceStatus.FAILED) {
        await this.markExecutionFailed(execution.id, 'Workspace setup failed', {
          workspaceStatus: ws.status,
        });
        return;
      }

      if (ws.isAgentWorking) {
        return;
      }

      if (ws.sessionFailureMessage) {
        await this.markExecutionFailed(execution.id, ws.sessionFailureMessage, {
          workspaceStatus: ws.status,
        });
        return;
      }

      // A human archiving the workspace ends the run; that is not a failure.
      const archived = ws.status === WorkspaceStatus.ARCHIVED;
      const readyGraceElapsed =
        ws.status === WorkspaceStatus.READY &&
        ws.initCompletedAt !== null &&
        Date.now() - ws.initCompletedAt.getTime() >= PERIODIC_TASK_READY_WITHOUT_PR_GRACE_MS;
      if (!(archived || readyGraceElapsed)) {
        return;
      }
      // Session startup failures are not recorded as lifecycle events, so a
      // finished run must also prove its agent session actually launched.
      if (!ws.hasLaunchedSession) {
        await this.markExecutionFailed(execution.id, 'Agent session did not start', {
          workspaceStatus: ws.status,
        });
        return;
      }

      await periodicTaskAccessor.updateExecution(execution.id, {
        status: 'COMPLETED',
        completedAt: new Date(),
      });
      this.logger.info('Periodic task execution completed without PR', {
        executionId: execution.id,
        workspaceStatus: ws.status,
      });
    } catch (error) {
      this.logger.error('Failed to check execution status', {
        executionId: execution.id,
        error: toError(error).message,
      });
    }
  }
}
