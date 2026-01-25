/**
 * Crash Recovery Service
 *
 * Handles crash loop detection, agent recovery, and system resilience.
 * Integrates with CLI process status tracking for accurate crash detection.
 */

import { AgentType, type CliProcessStatus, ExecutionState, TaskState } from '@prisma-gen/client';
import { agentProcessAdapter } from '../agents/process-adapter.js';
import {
  agentAccessor,
  decisionLogAccessor,
  mailAccessor,
  taskAccessor,
} from '../resource_accessors/index.js';
import { configService } from './config.service.js';
import { createLogger } from './logger.service.js';
import { notificationService } from './notification.service.js';

const logger = createLogger('crash-recovery');

/**
 * Crash record for tracking agent crashes
 */
interface CrashRecord {
  agentId: string;
  agentType: AgentType;
  timestamps: number[];
  topLevelTaskId?: string;
  taskId?: string;
  lastCliProcessStatus?: CliProcessStatus;
  lastExitCode?: number;
}

/**
 * Recovery result
 */
interface RecoveryResult {
  success: boolean;
  action: 'recovered' | 'marked_failed' | 'crash_loop' | 'no_action';
  message: string;
  newAgentId?: string;
}

/**
 * System health status
 */
export interface SystemHealthStatus {
  isHealthy: boolean;
  databaseConnected: boolean;
  orchestratorHealthy: boolean;
  supervisorCount: number;
  healthySupervisors: number;
  workerCount: number;
  healthyWorkers: number;
  crashLoopAgents: string[];
  issues: string[];
}

/**
 * CrashRecoveryService class
 */
class CrashRecoveryService {
  private crashRecords: Map<string, CrashRecord> = new Map();

  /**
   * Record an agent crash with optional CLI process information
   */
  recordCrash(
    agentId: string,
    agentType: AgentType,
    topLevelTaskId?: string,
    taskId?: string,
    cliProcessStatus?: CliProcessStatus,
    exitCode?: number
  ): void {
    const now = Date.now();
    const existing = this.crashRecords.get(agentId);

    if (existing) {
      existing.timestamps.push(now);
      // Keep only recent crashes (last hour)
      existing.timestamps = existing.timestamps.filter((ts) => now - ts < 3_600_000);
      // Update CLI process info
      if (cliProcessStatus !== undefined) {
        existing.lastCliProcessStatus = cliProcessStatus;
      }
      if (exitCode !== undefined) {
        existing.lastExitCode = exitCode;
      }
    } else {
      this.crashRecords.set(agentId, {
        agentId,
        agentType,
        timestamps: [now],
        topLevelTaskId,
        taskId,
        lastCliProcessStatus: cliProcessStatus,
        lastExitCode: exitCode,
      });
    }

    logger.warn('Agent crash recorded', {
      agentId,
      agentType,
      crashCount: this.crashRecords.get(agentId)?.timestamps.length,
      topLevelTaskId,
      taskId,
      cliProcessStatus,
      exitCode,
    });
  }

  /**
   * Check if an agent is in a crash loop
   */
  isInCrashLoop(agentId: string): boolean {
    const config = configService.getSystemConfig();
    const record = this.crashRecords.get(agentId);

    if (!record) {
      return false;
    }

    const now = Date.now();
    const recentCrashes = record.timestamps.filter((ts) => now - ts < config.crashLoopThresholdMs);

    return recentCrashes.length >= config.maxRapidCrashes;
  }

  /**
   * Get all agents in crash loops
   */
  getCrashLoopAgents(): string[] {
    return Array.from(this.crashRecords.keys()).filter((agentId) => this.isInCrashLoop(agentId));
  }

  /**
   * Handle agent crash with recovery logic.
   * Integrates with CLI process status for accurate crash detection and logging.
   */
  async handleAgentCrash(
    agentId: string,
    agentType: AgentType,
    topLevelTaskId?: string,
    taskId?: string,
    error?: Error,
    cliProcessStatus?: CliProcessStatus,
    exitCode?: number
  ): Promise<RecoveryResult> {
    // If CLI process info not provided, try to get it from the agent
    let finalCliProcessStatus = cliProcessStatus;
    let finalExitCode = exitCode;

    if (finalCliProcessStatus === undefined) {
      try {
        const agent = await agentAccessor.findById(agentId);
        if (agent) {
          finalCliProcessStatus = agent.cliProcessStatus ?? undefined;
          finalExitCode = agent.cliProcessExitCode ?? undefined;
        }
      } catch (e) {
        // Ignore errors, we'll proceed without CLI info
        logger.debug('Failed to fetch agent CLI process info', { agentId, error: e });
      }
    }

    // Record the crash with CLI process information
    this.recordCrash(
      agentId,
      agentType,
      topLevelTaskId,
      taskId,
      finalCliProcessStatus,
      finalExitCode
    );

    logger.error('Handling agent crash', error || new Error('Unknown crash'), {
      agentId,
      agentType,
      topLevelTaskId,
      taskId,
      cliProcessStatus: finalCliProcessStatus,
      exitCode: finalExitCode,
    });

    // Check for crash loop
    if (this.isInCrashLoop(agentId)) {
      return this.handleCrashLoop(agentId, agentType, topLevelTaskId, taskId);
    }

    // Attempt recovery based on agent type
    switch (agentType) {
      case AgentType.WORKER:
        return this.recoverWorker(agentId, taskId);

      case AgentType.SUPERVISOR:
        return this.recoverSupervisor(agentId, topLevelTaskId);

      case AgentType.ORCHESTRATOR:
        return this.recoverOrchestrator(agentId);

      default:
        return Promise.resolve({
          success: false,
          action: 'no_action' as const,
          message: `Unknown agent type: ${agentType}`,
        });
    }
  }

  /**
   * Handle crash loop (agent crashing repeatedly)
   */
  private async handleCrashLoop(
    agentId: string,
    agentType: AgentType,
    topLevelTaskId?: string,
    taskId?: string
  ): Promise<RecoveryResult> {
    const config = configService.getSystemConfig();

    logger.error('Agent in crash loop, marking as permanently failed', {
      agentId,
      agentType,
      topLevelTaskId,
      taskId,
    });

    // Mark agent as crashed
    await agentAccessor.update(agentId, {
      executionState: ExecutionState.CRASHED,
    });

    // Handle task/top-level task state
    if (taskId && agentType === AgentType.WORKER) {
      await taskAccessor.update(taskId, {
        state: TaskState.FAILED,
        failureReason: `Worker ${agentId} entered crash loop (${config.maxRapidCrashes} crashes in ${config.crashLoopThresholdMs / 1000}s)`,
      });
    }

    if (topLevelTaskId && agentType === AgentType.SUPERVISOR) {
      await taskAccessor.update(topLevelTaskId, {
        state: TaskState.BLOCKED,
      });
    }

    // Send notification
    await notificationService.notifyCriticalError(
      agentType,
      topLevelTaskId ? (await taskAccessor.findById(topLevelTaskId))?.title : undefined,
      `Agent ${agentId} entered crash loop and has been marked as failed`
    );

    // Send mail to human
    await mailAccessor.create({
      isForHuman: true,
      subject: `CRITICAL: ${agentType} in Crash Loop`,
      body: `Agent ${agentId} (${agentType}) has crashed ${config.maxRapidCrashes} times in ${config.crashLoopThresholdMs / 1000} seconds and has been marked as permanently failed.\n\nTop-level Task ID: ${topLevelTaskId || 'N/A'}\nTask ID: ${taskId || 'N/A'}\n\nManual investigation and intervention required.`,
    });

    return {
      success: false,
      action: 'crash_loop',
      message: `Agent marked as permanently failed due to crash loop`,
    };
  }

  /**
   * Recover a crashed worker.
   * Updates CLI process status and prepares task for new worker assignment.
   */
  private async recoverWorker(agentId: string, taskId?: string): Promise<RecoveryResult> {
    if (!taskId) {
      logger.warn('Cannot recover worker without task ID', { agentId });
      return {
        success: false,
        action: 'no_action',
        message: 'No task ID provided for worker recovery',
      };
    }

    const task = await taskAccessor.findById(taskId);
    if (!task) {
      return {
        success: false,
        action: 'no_action',
        message: `Task ${taskId} not found`,
      };
    }

    const config = configService.getSystemConfig();
    const attempts = (task.attempts || 0) + 1;

    // Get crash record to include CLI info in logging
    const crashRecord = this.crashRecords.get(agentId);

    // Check if max attempts reached
    if (attempts >= config.maxWorkerAttempts) {
      await taskAccessor.update(taskId, {
        state: TaskState.FAILED,
        attempts,
        failureReason: `Worker crashed ${config.maxWorkerAttempts} times${crashRecord?.lastCliProcessStatus ? ` (last status: ${crashRecord.lastCliProcessStatus})` : ''}`,
      });

      await agentAccessor.update(agentId, {
        executionState: ExecutionState.CRASHED,
        cliProcessStatus: 'CRASHED',
      });

      // Notify human
      await mailAccessor.create({
        isForHuman: true,
        subject: `Task Failed: ${task.title}`,
        body: `Task "${task.title}" has failed after ${config.maxWorkerAttempts} worker recovery attempts.\n\nTask ID: ${taskId}\nParent Task ID: ${task.parentId || 'N/A'}\nLast CLI Process Status: ${crashRecord?.lastCliProcessStatus || 'unknown'}\nLast Exit Code: ${crashRecord?.lastExitCode ?? 'unknown'}\n\nManual intervention required.`,
      });

      await notificationService.notifyTaskFailed(
        task.title,
        `Failed after ${config.maxWorkerAttempts} attempts`
      );

      return {
        success: false,
        action: 'marked_failed',
        message: `Task marked as failed after ${config.maxWorkerAttempts} attempts`,
      };
    }

    // Get session ID from the old worker for potential resume capability
    // This allows the new worker to continue where the crashed one left off
    const oldWorker = await agentAccessor.findById(agentId);
    const sessionIdForResume =
      agentProcessAdapter.getClaudeSessionId(agentId) || oldWorker?.sessionId;

    // Mark old worker as crashed with CLI process status
    await agentAccessor.update(agentId, {
      executionState: ExecutionState.CRASHED,
      cliProcessStatus: 'CRASHED',
    });

    // Reset task for new worker (the reconciler will pick this up and create a new worker)
    // Store the session ID in the task metadata for the new worker to use
    await taskAccessor.update(taskId, {
      state: TaskState.PENDING,
      assignedAgentId: null,
      attempts,
    });

    logger.info('Worker recovery initiated', {
      oldWorkerId: agentId,
      taskId,
      attempt: attempts,
      sessionIdForResume: sessionIdForResume ? 'available' : 'none',
      lastCliProcessStatus: crashRecord?.lastCliProcessStatus,
      lastExitCode: crashRecord?.lastExitCode,
    });

    // Log the decision
    await decisionLogAccessor.createManual(
      agentId,
      `Worker crashed, task reset for recovery attempt ${attempts}`,
      `Worker became unresponsive or crashed (CLI status: ${crashRecord?.lastCliProcessStatus || 'unknown'})`,
      JSON.stringify({
        taskId,
        attempts,
        cliProcessStatus: crashRecord?.lastCliProcessStatus,
        exitCode: crashRecord?.lastExitCode,
        sessionIdForResume: !!sessionIdForResume,
      })
    );

    return {
      success: true,
      action: 'recovered',
      message: `Task reset for recovery (attempt ${attempts}/${config.maxWorkerAttempts})`,
    };
  }

  /**
   * Recover a crashed supervisor.
   * Updates CLI process status and prepares for new supervisor creation.
   */
  private async recoverSupervisor(
    agentId: string,
    topLevelTaskId?: string
  ): Promise<RecoveryResult> {
    if (!topLevelTaskId) {
      logger.warn('Cannot recover supervisor without top-level task ID', { agentId });
      return {
        success: false,
        action: 'no_action',
        message: 'No top-level task ID provided for supervisor recovery',
      };
    }

    const topLevelTask = await taskAccessor.findById(topLevelTaskId);
    if (!topLevelTask) {
      return {
        success: false,
        action: 'no_action',
        message: `Top-level task ${topLevelTaskId} not found`,
      };
    }

    // Get crash record to include CLI info
    const crashRecord = this.crashRecords.get(agentId);

    // Mark old supervisor as crashed with CLI process status
    await agentAccessor.update(agentId, {
      executionState: ExecutionState.CRASHED,
      cliProcessStatus: 'CRASHED',
      currentTaskId: null,
    });

    // Mark all active workers for this top-level task as needing recovery
    const tasks = await taskAccessor.list({ parentId: topLevelTaskId });
    let workersReset = 0;
    for (const task of tasks) {
      if (task.assignedAgentId && task.state === TaskState.IN_PROGRESS) {
        // Mark worker's task as pending for reassignment
        await taskAccessor.update(task.id, {
          state: TaskState.PENDING,
          assignedAgentId: null,
        });

        // Mark worker as crashed with CLI process status
        await agentAccessor.update(task.assignedAgentId, {
          executionState: ExecutionState.CRASHED,
          cliProcessStatus: 'KILLED', // Workers are killed when supervisor crashes
        });
        workersReset++;
      }
    }

    // Update top-level task state - set to PLANNING so reconciler creates new supervisor
    await taskAccessor.update(topLevelTaskId, {
      state: TaskState.PLANNING,
    });

    // Notify human
    await mailAccessor.create({
      isForHuman: true,
      subject: `Supervisor Crashed: ${topLevelTask.title}`,
      body: `The supervisor for task "${topLevelTask.title}" has crashed.\n\nTask ID: ${topLevelTaskId}\nCLI Process Status: ${crashRecord?.lastCliProcessStatus || 'unknown'}\nExit Code: ${crashRecord?.lastExitCode ?? 'unknown'}\nWorkers Reset: ${workersReset}\n\nThe reconciler will create a new supervisor automatically.`,
    });

    await notificationService.notifyCriticalError(
      'Supervisor',
      topLevelTask.title,
      'Supervisor crashed - new supervisor will be created'
    );

    logger.info('Supervisor recovery initiated', {
      oldSupervisorId: agentId,
      topLevelTaskId,
      workersReset,
      lastCliProcessStatus: crashRecord?.lastCliProcessStatus,
      lastExitCode: crashRecord?.lastExitCode,
    });

    return {
      success: true,
      action: 'recovered',
      message: `Supervisor marked as failed, ${workersReset} workers reset, task ready for new supervisor`,
    };
  }

  /**
   * Recover the orchestrator.
   * Updates CLI process status and notifies humans for manual intervention.
   */
  private async recoverOrchestrator(agentId: string): Promise<RecoveryResult> {
    // Get crash record to include CLI info
    const crashRecord = this.crashRecords.get(agentId);

    // Mark old orchestrator as crashed with CLI process status
    await agentAccessor.update(agentId, {
      executionState: ExecutionState.CRASHED,
      cliProcessStatus: 'CRASHED',
    });

    // Notify human - orchestrator recovery is critical
    await mailAccessor.create({
      isForHuman: true,
      subject: 'CRITICAL: Orchestrator Crashed',
      body: `The system orchestrator has crashed.\n\nAgent ID: ${agentId}\nCLI Process Status: ${crashRecord?.lastCliProcessStatus || 'unknown'}\nExit Code: ${crashRecord?.lastExitCode ?? 'unknown'}\n\nThe orchestrator needs to be manually restarted. All supervisors will continue running but may need health checks.`,
    });

    await notificationService.notifyCriticalError(
      'Orchestrator',
      undefined,
      'System orchestrator crashed - manual restart required'
    );

    logger.error('Orchestrator crashed, manual intervention required', {
      orchestratorId: agentId,
      lastCliProcessStatus: crashRecord?.lastCliProcessStatus,
      lastExitCode: crashRecord?.lastExitCode,
    });

    return {
      success: false, // Orchestrator can't auto-recover
      action: 'marked_failed',
      message: 'Orchestrator marked as failed, manual restart required',
    };
  }

  /**
   * Get system health status.
   * Includes CLI process status checks for more accurate health reporting.
   */
  async getSystemHealthStatus(): Promise<SystemHealthStatus> {
    const issues: string[] = [];

    // Check database connection
    let databaseConnected = true;
    try {
      await agentAccessor.findByType(AgentType.ORCHESTRATOR);
    } catch {
      databaseConnected = false;
      issues.push('Database connection failed');
    }

    // Get orchestrator status
    const orchestrators = await agentAccessor.findByType(AgentType.ORCHESTRATOR);
    const activeOrchestrator = orchestrators.find(
      (o) => o.executionState === ExecutionState.ACTIVE || o.executionState === ExecutionState.IDLE
    );
    const orchestratorHealthy = !!activeOrchestrator;

    if (!orchestratorHealthy) {
      issues.push('No active orchestrator found');
    }

    // Get supervisor status - check both execution state and CLI process status
    const supervisors = await agentAccessor.findByType(AgentType.SUPERVISOR);
    const healthySupervisors = supervisors.filter((s) => {
      // Check execution state
      if (s.executionState === ExecutionState.CRASHED) {
        return false;
      }
      // Check CLI process status
      const cliStatus = s.cliProcessStatus;
      if (cliStatus === 'CRASHED' || cliStatus === 'KILLED' || cliStatus === 'EXITED') {
        return false;
      }
      // Check if process is actually running for active agents
      if (s.executionState === ExecutionState.ACTIVE) {
        return agentProcessAdapter.isRunning(s.id);
      }
      return true;
    });

    // Get worker status - check both execution state and CLI process status
    const workers = await agentAccessor.findByType(AgentType.WORKER);
    const healthyWorkers = workers.filter((w) => {
      // Check execution state
      if (w.executionState === ExecutionState.CRASHED) {
        return false;
      }
      // Check CLI process status
      const cliStatus = w.cliProcessStatus;
      if (cliStatus === 'CRASHED' || cliStatus === 'KILLED' || cliStatus === 'EXITED') {
        return false;
      }
      // Check if process is actually running for active agents
      if (w.executionState === ExecutionState.ACTIVE) {
        return agentProcessAdapter.isRunning(w.id);
      }
      return true;
    });

    // Check for orphaned agents (DB says active but process not running)
    const orphanedAgents = [...supervisors, ...workers].filter((a) => {
      if (a.executionState !== ExecutionState.ACTIVE) {
        return false;
      }
      return !agentProcessAdapter.isRunning(a.id);
    });
    if (orphanedAgents.length > 0) {
      issues.push(`${orphanedAgents.length} orphaned agents (DB active but process not running)`);
    }

    // Get crash loop agents
    const crashLoopAgents = this.getCrashLoopAgents();
    if (crashLoopAgents.length > 0) {
      issues.push(`${crashLoopAgents.length} agents in crash loop`);
    }

    return {
      isHealthy: databaseConnected && orchestratorHealthy && issues.length === 0,
      databaseConnected,
      orchestratorHealthy,
      supervisorCount: supervisors.length,
      healthySupervisors: healthySupervisors.length,
      workerCount: workers.length,
      healthyWorkers: healthyWorkers.length,
      crashLoopAgents,
      issues,
    };
  }

  /**
   * Clear crash records for an agent (after successful recovery)
   */
  clearCrashRecords(agentId: string): void {
    this.crashRecords.delete(agentId);
    logger.debug('Crash records cleared', { agentId });
  }

  /**
   * Clear all crash records
   */
  clearAllCrashRecords(): void {
    this.crashRecords.clear();
    logger.info('All crash records cleared');
  }
}

// Export singleton instance
export const crashRecoveryService = new CrashRecoveryService();
