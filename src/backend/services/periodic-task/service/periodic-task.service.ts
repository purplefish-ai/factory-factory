/**
 * Periodic Task Service
 *
 * Polling loop that:
 * 1. Finds enabled periodic tasks where nextRunAt <= now
 * 2. Skips tasks that already have a RUNNING execution
 * 3. Reserves an execution + creates a new workspace for due tasks
 * 4. Monitors RUNNING executions for PR creation or failure
 */

import { toError } from '@/backend/lib/error-utils';
import { SERVICE_INTERVAL_MS } from '@/backend/services/constants';
import type { createLogger } from '@/backend/services/logger.service';
import { periodicTaskAccessor } from '@/backend/services/periodic-task/resources/periodic-task.accessor';
import { type PeriodicTaskCadence, WorkspaceStatus } from '@/shared/core';

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

/** Bridge for workspace creation — wired by orchestration layer. */
export interface PeriodicTaskWorkspaceBridge {
  createWorkspaceForTask(params: {
    projectId: string;
    name: string;
    prompt: string;
    periodicTaskId: string;
  }): Promise<{ workspaceId: string }>;
}

/** Bridge for checking workspace PR state. */
export interface PeriodicTaskWorkspaceStatusBridge {
  getWorkspaceStatus(workspaceId: string): Promise<{
    status: WorkspaceStatus;
    prUrl: string | null;
    prNumber: number | null;
    isAgentWorking: boolean;
    initCompletedAt: Date | null;
  } | null>;
}

export class PeriodicTaskService {
  private isShuttingDown = false;
  private pollLoop: Promise<void> | null = null;
  private sleepTimeout: NodeJS.Timeout | null = null;
  private sleepResolve: (() => void) | null = null;

  private workspaceBridge: PeriodicTaskWorkspaceBridge | null = null;
  private statusBridge: PeriodicTaskWorkspaceStatusBridge | null = null;

  constructor(private readonly logger: Logger) {}

  configure(bridges: {
    workspace: PeriodicTaskWorkspaceBridge;
    status: PeriodicTaskWorkspaceStatusBridge;
  }): void {
    this.workspaceBridge = bridges.workspace;
    this.statusBridge = bridges.status;
  }

  list(projectId: string) {
    return periodicTaskAccessor.listByProject(projectId);
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
    if (this.pollLoop !== null) {
      return;
    }
    this.isShuttingDown = false;
    this.logger.info('Periodic task service starting');
    this.pollLoop = this.runLoop();
  }

  async stop(): Promise<void> {
    if (!this.pollLoop) {
      return;
    }
    this.isShuttingDown = true;
    this.wakeSleep();
    await this.pollLoop;
    this.pollLoop = null;
    this.logger.info('Periodic task service stopped');
  }

  // ─── Main Loop ──────────────────────────────────────────────────────────

  private async runLoop(): Promise<void> {
    while (!this.isShuttingDown) {
      try {
        await this.pollDueTasks();
        await this.checkRunningExecutions();
      } catch (error) {
        this.logger.error('Periodic task poll error', toError(error));
      }

      if (!this.isShuttingDown) {
        await this.sleep(SERVICE_INTERVAL_MS.periodicTaskPoll);
      }
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
    if (!this.workspaceBridge) {
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
      result = await this.workspaceBridge.createWorkspaceForTask({
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

      if (ws.status === WorkspaceStatus.FAILED || ws.status === WorkspaceStatus.ARCHIVED) {
        await periodicTaskAccessor.updateExecution(execution.id, {
          status: 'FAILED',
          errorMessage: `Workspace ended in ${ws.status} state`,
          completedAt: new Date(),
        });
        this.logger.warn('Periodic task execution failed', {
          executionId: execution.id,
          workspaceStatus: ws.status,
        });
        return;
      }

      const readyWithoutPrGraceElapsed =
        ws.initCompletedAt !== null &&
        Date.now() - ws.initCompletedAt.getTime() >= PERIODIC_TASK_READY_WITHOUT_PR_GRACE_MS;
      if (ws.status === WorkspaceStatus.READY && !ws.isAgentWorking && readyWithoutPrGraceElapsed) {
        await periodicTaskAccessor.updateExecution(execution.id, {
          status: 'FAILED',
          errorMessage: 'Workspace is READY without a PR and no agent work is active',
          completedAt: new Date(),
        });
        this.logger.warn('Periodic task execution finished without PR', {
          executionId: execution.id,
          workspaceStatus: ws.status,
        });
      }
    } catch (error) {
      this.logger.error('Failed to check execution status', {
        executionId: execution.id,
        error: toError(error).message,
      });
    }
  }

  // ─── Sleep helpers ──────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepResolve = resolve;
      this.sleepTimeout = setTimeout(() => {
        this.sleepResolve = null;
        this.sleepTimeout = null;
        resolve();
      }, ms);
    });
  }

  private wakeSleep(): void {
    if (this.sleepTimeout) {
      clearTimeout(this.sleepTimeout);
      this.sleepTimeout = null;
    }
    if (this.sleepResolve) {
      this.sleepResolve();
      this.sleepResolve = null;
    }
  }
}
