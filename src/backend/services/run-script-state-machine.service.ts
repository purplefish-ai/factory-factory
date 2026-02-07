/**
 * Run Script State Machine Service
 *
 * Manages run script status transitions with validation.
 * Ensures only valid state transitions occur and provides
 * single-writer ownership of run script lifecycle.
 *
 * State Diagram:
 *   IDLE → STARTING (start requested)
 *   STARTING → RUNNING (process spawned successfully)
 *   STARTING → FAILED (spawn error)
 *   RUNNING → STOPPING (stop requested)
 *   RUNNING → COMPLETED (process exited with code 0)
 *   RUNNING → FAILED (process exited with non-zero code or error)
 *   STOPPING → IDLE (cleanup complete)
 *   COMPLETED → IDLE (user acknowledgment or restart)
 *   FAILED → IDLE (user acknowledgment or restart)
 */

import type { RunScriptStatus, Workspace } from '@prisma-gen/client';
import { prisma } from '../db';
import { createLogger } from './logger.service';

const logger = createLogger('run-script-state-machine');

/**
 * Valid state transitions for run script status.
 */
const VALID_TRANSITIONS: Record<RunScriptStatus, RunScriptStatus[]> = {
  IDLE: ['STARTING'],
  STARTING: ['RUNNING', 'FAILED', 'STOPPING'],
  RUNNING: ['STOPPING', 'COMPLETED', 'FAILED'],
  STOPPING: ['IDLE'],
  COMPLETED: ['IDLE', 'STARTING'],
  FAILED: ['IDLE', 'STARTING'],
};

/**
 * Error thrown when an invalid state transition is attempted.
 */
export class RunScriptStateMachineError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly fromStatus: RunScriptStatus,
    public readonly toStatus: RunScriptStatus,
    message?: string
  ) {
    super(
      message ??
        `Invalid run script state transition: ${fromStatus} → ${toStatus} (workspace: ${workspaceId})`
    );
    this.name = 'RunScriptStateMachineError';
  }
}

export interface TransitionOptions {
  /** Process ID to set (for STARTING → RUNNING transition) */
  pid?: number;
  /** Port to set (for STARTING → RUNNING transition) */
  port?: number;
  /** Started timestamp (for STARTING → RUNNING transition) */
  startedAt?: Date;
}

class RunScriptStateMachineService {
  /**
   * Check if a state transition is valid.
   */
  isValidTransition(from: RunScriptStatus, to: RunScriptStatus): boolean {
    return VALID_TRANSITIONS[from].includes(to);
  }

  /**
   * Transition a workspace's run script to a new status with validation.
   *
   * @throws RunScriptStateMachineError if the transition is invalid
   */
  async transition(
    workspaceId: string,
    targetStatus: RunScriptStatus,
    options?: TransitionOptions
  ): Promise<Workspace> {
    // First read to validate the transition and get current status for logging
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const currentStatus = workspace.runScriptStatus;

    if (!this.isValidTransition(currentStatus, targetStatus)) {
      throw new RunScriptStateMachineError(workspaceId, currentStatus, targetStatus);
    }

    const updateData: Parameters<typeof prisma.workspace.update>[0]['data'] = {
      runScriptStatus: targetStatus,
    };

    // Apply transition-specific updates
    switch (targetStatus) {
      case 'STARTING':
        // Clear previous state when starting
        updateData.runScriptPid = null;
        updateData.runScriptPort = null;
        updateData.runScriptStartedAt = null;
        break;

      case 'RUNNING':
        // Set process details when running
        if (options?.pid !== undefined) {
          updateData.runScriptPid = options.pid;
        }
        if (options?.port !== undefined) {
          updateData.runScriptPort = options.port;
        }
        // Always set startedAt when transitioning to RUNNING
        updateData.runScriptStartedAt = options?.startedAt ?? new Date();
        break;

      case 'IDLE':
      case 'COMPLETED':
      case 'FAILED':
        // Clear process details when stopped/completed/failed
        updateData.runScriptPid = null;
        updateData.runScriptPort = null;
        updateData.runScriptStartedAt = null;
        break;

      case 'STOPPING':
        // Keep process details during stopping
        break;
    }

    // Atomic compare-and-swap: only update if status hasn't changed since we read it.
    // This prevents two concurrent callers from both passing validation and racing to write.
    const result = await prisma.workspace.updateMany({
      where: { id: workspaceId, runScriptStatus: currentStatus },
      data: updateData,
    });

    if (result.count === 0) {
      // Status changed between read and write — refetch to report the actual conflict
      const refreshed = await prisma.workspace.findUnique({ where: { id: workspaceId } });
      throw new RunScriptStateMachineError(
        workspaceId,
        refreshed?.runScriptStatus ?? currentStatus,
        targetStatus,
        `Concurrent state change detected: status was ${currentStatus}, now ${refreshed?.runScriptStatus ?? 'unknown'} (target: ${targetStatus})`
      );
    }

    logger.debug('Run script status transitioned', {
      workspaceId,
      from: currentStatus,
      to: targetStatus,
    });

    // Fetch and return the updated workspace (updateMany doesn't return the record)
    const updated = await prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
    });

    return updated;
  }

  /**
   * Start the run script (transition to STARTING).
   * Verifies the process isn't stale before transitioning.
   * Returns null (instead of throwing) if already RUNNING.
   */
  async start(workspaceId: string): Promise<Workspace | null> {
    // Verify + transition atomically: check for stale processes first
    const status = await this.verifyRunning(workspaceId);
    if (status === 'RUNNING') {
      return null; // Already running — caller should return friendly message
    }
    return await this.transition(workspaceId, 'STARTING');
  }

  /**
   * Mark run script as running (transition to RUNNING).
   * Must be called from STARTING state after process spawns successfully.
   */
  async markRunning(
    workspaceId: string,
    options: Required<Pick<TransitionOptions, 'pid'>> & Pick<TransitionOptions, 'port'>
  ): Promise<Workspace> {
    return await this.transition(workspaceId, 'RUNNING', {
      ...options,
      startedAt: new Date(),
    });
  }

  /**
   * Begin stopping the run script (transition to STOPPING).
   * Must be called from RUNNING state when stop is requested.
   */
  async beginStopping(workspaceId: string): Promise<Workspace> {
    return await this.transition(workspaceId, 'STOPPING');
  }

  /**
   * Complete stopping and return to IDLE.
   * Must be called from STOPPING state after cleanup is complete.
   */
  async completeStopping(workspaceId: string): Promise<Workspace> {
    return await this.transition(workspaceId, 'IDLE');
  }

  /**
   * Mark run script as completed (process exited with code 0).
   * Must be called from RUNNING state.
   */
  async markCompleted(workspaceId: string): Promise<Workspace> {
    return await this.transition(workspaceId, 'COMPLETED');
  }

  /**
   * Mark run script as failed.
   * Can be called from STARTING (spawn error) or RUNNING (process error/non-zero exit).
   */
  async markFailed(workspaceId: string): Promise<Workspace> {
    return await this.transition(workspaceId, 'FAILED');
  }

  /**
   * Reset to IDLE state.
   * Can be called from COMPLETED or FAILED states.
   */
  async reset(workspaceId: string): Promise<Workspace> {
    return await this.transition(workspaceId, 'IDLE');
  }

  /**
   * Check current status and verify process is still running.
   * Updates status to FAILED if process is stale.
   *
   * @returns Current status (possibly updated)
   */
  async verifyRunning(workspaceId: string): Promise<RunScriptStatus> {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    // Only verify if status says RUNNING
    if (workspace.runScriptStatus === 'RUNNING' && workspace.runScriptPid) {
      try {
        // Check if process exists (signal 0 doesn't kill, just checks)
        process.kill(workspace.runScriptPid, 0);
        // Process exists
        return 'RUNNING';
      } catch {
        // Process doesn't exist, mark as failed
        logger.warn('Detected stale run script process, marking as failed', {
          workspaceId,
          pid: workspace.runScriptPid,
        });
        try {
          await this.markFailed(workspaceId);
          return 'FAILED';
        } catch (stateError) {
          // Race condition: exit handler already transitioned state
          logger.debug('Failed to mark as FAILED (likely already transitioned)', {
            workspaceId,
            error: stateError,
          });
          // Refetch to get current state
          const updated = await prisma.workspace.findUnique({ where: { id: workspaceId } });
          return updated?.runScriptStatus ?? workspace.runScriptStatus;
        }
      }
    }

    return workspace.runScriptStatus;
  }
}

export const runScriptStateMachine = new RunScriptStateMachineService();
