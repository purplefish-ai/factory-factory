/**
 * Periodic Task Service
 *
 * Polling loop that:
 * 1. Finds enabled periodic tasks where nextRunAt <= now
 * 2. Skips tasks that already have a RUNNING execution
 * 3. Creates a new workspace + execution for due tasks
 * 4. Monitors RUNNING executions for PR creation or failure
 */

import { toError } from '@/backend/lib/error-utils';
import { SERVICE_INTERVAL_MS } from '@/backend/services/constants';
import type { createLogger } from '@/backend/services/logger.service';
import { periodicTaskAccessor } from '@/backend/services/periodic-task/resources/periodic-task.accessor';
import type { PeriodicTaskCadence } from '@/shared/core';

type Logger = ReturnType<typeof createLogger>;

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
    status: string;
    prUrl: string | null;
    prNumber: number | null;
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
          task.timezone
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
    timezone: string | null
  ): Promise<void> {
    if (!this.workspaceBridge) {
      this.logger.warn('Periodic task service not configured — skipping dispatch');
      return;
    }

    this.logger.info('Dispatching periodic task', { taskId, name });

    // Advance nextRunAt first so a crash after this point won't re-dispatch
    // the same due window on the next poll (at worst we miss one run).
    await periodicTaskAccessor.markDispatched(taskId, cadence, scheduledTime, timezone);

    const result = await this.workspaceBridge.createWorkspaceForTask({
      projectId,
      name: `${name} — ${new Date().toLocaleDateString()}`,
      prompt,
      periodicTaskId: taskId,
    });

    await periodicTaskAccessor.createExecution({
      periodicTaskId: taskId,
      workspaceId: result.workspaceId,
      status: 'RUNNING',
    });

    this.logger.info('Periodic task dispatched', {
      taskId,
      workspaceId: result.workspaceId,
    });
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
  }): Promise<void> {
    try {
      if (!(execution.workspaceId && this.statusBridge)) {
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

      if (ws.status === 'FAILED' || ws.status === 'ARCHIVED') {
        await periodicTaskAccessor.updateExecution(execution.id, {
          status: 'FAILED',
          errorMessage: `Workspace ended in ${ws.status} state`,
          completedAt: new Date(),
        });
        this.logger.warn('Periodic task execution failed', {
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
