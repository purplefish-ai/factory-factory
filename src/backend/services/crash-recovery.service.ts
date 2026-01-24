/**
 * Crash Recovery Service
 *
 * Handles crash loop detection, agent recovery, and system resilience.
 */

import { AgentState, AgentType, EpicState, TaskState } from '@prisma-gen/client';
import {
  agentAccessor,
  decisionLogAccessor,
  epicAccessor,
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
  epicId?: string;
  taskId?: string;
}

/**
 * Recovery result
 */
export interface RecoveryResult {
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
export class CrashRecoveryService {
  private crashRecords: Map<string, CrashRecord> = new Map();

  /**
   * Record an agent crash
   */
  recordCrash(agentId: string, agentType: AgentType, epicId?: string, taskId?: string): void {
    const now = Date.now();
    const existing = this.crashRecords.get(agentId);

    if (existing) {
      existing.timestamps.push(now);
      // Keep only recent crashes (last hour)
      existing.timestamps = existing.timestamps.filter((ts) => now - ts < 3_600_000);
    } else {
      this.crashRecords.set(agentId, {
        agentId,
        agentType,
        timestamps: [now],
        epicId,
        taskId,
      });
    }

    logger.warn('Agent crash recorded', {
      agentId,
      agentType,
      crashCount: this.crashRecords.get(agentId)?.timestamps.length,
      epicId,
      taskId,
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
   * Handle agent crash with recovery logic
   */
  async handleAgentCrash(
    agentId: string,
    agentType: AgentType,
    epicId?: string,
    taskId?: string,
    error?: Error
  ): Promise<RecoveryResult> {
    // Record the crash
    this.recordCrash(agentId, agentType, epicId, taskId);

    logger.error('Handling agent crash', error || new Error('Unknown crash'), {
      agentId,
      agentType,
      epicId,
      taskId,
    });

    // Check for crash loop
    if (this.isInCrashLoop(agentId)) {
      return this.handleCrashLoop(agentId, agentType, epicId, taskId);
    }

    // Attempt recovery based on agent type
    switch (agentType) {
      case AgentType.WORKER:
        return this.recoverWorker(agentId, taskId);

      case AgentType.SUPERVISOR:
        return this.recoverSupervisor(agentId, epicId);

      case AgentType.ORCHESTRATOR:
        return this.recoverOrchestrator(agentId);

      default:
        return {
          success: false,
          action: 'no_action',
          message: `Unknown agent type: ${agentType}`,
        };
    }
  }

  /**
   * Handle crash loop (agent crashing repeatedly)
   */
  private async handleCrashLoop(
    agentId: string,
    agentType: AgentType,
    epicId?: string,
    taskId?: string
  ): Promise<RecoveryResult> {
    const config = configService.getSystemConfig();

    logger.error('Agent in crash loop, marking as permanently failed', {
      agentId,
      agentType,
      epicId,
      taskId,
    });

    // Mark agent as failed
    await agentAccessor.update(agentId, {
      state: AgentState.FAILED,
    });

    // Handle task/epic state
    if (taskId && agentType === AgentType.WORKER) {
      await taskAccessor.update(taskId, {
        state: TaskState.FAILED,
        failureReason: `Worker ${agentId} entered crash loop (${config.maxRapidCrashes} crashes in ${config.crashLoopThresholdMs / 1000}s)`,
      });
    }

    if (epicId && agentType === AgentType.SUPERVISOR) {
      await epicAccessor.update(epicId, {
        state: EpicState.BLOCKED,
      });
    }

    // Send notification
    await notificationService.notifyCriticalError(
      agentType,
      epicId ? (await epicAccessor.findById(epicId))?.title : undefined,
      `Agent ${agentId} entered crash loop and has been marked as failed`
    );

    // Send mail to human
    await mailAccessor.create({
      isForHuman: true,
      subject: `CRITICAL: ${agentType} in Crash Loop`,
      body: `Agent ${agentId} (${agentType}) has crashed ${config.maxRapidCrashes} times in ${config.crashLoopThresholdMs / 1000} seconds and has been marked as permanently failed.\n\nEpic ID: ${epicId || 'N/A'}\nTask ID: ${taskId || 'N/A'}\n\nManual investigation and intervention required.`,
    });

    return {
      success: false,
      action: 'crash_loop',
      message: `Agent marked as permanently failed due to crash loop`,
    };
  }

  /**
   * Recover a crashed worker
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

    // Check if max attempts reached
    if (attempts >= config.maxWorkerAttempts) {
      await taskAccessor.update(taskId, {
        state: TaskState.FAILED,
        attempts,
        failureReason: `Worker crashed ${config.maxWorkerAttempts} times`,
      });

      await agentAccessor.update(agentId, {
        state: AgentState.FAILED,
      });

      // Notify human
      await mailAccessor.create({
        isForHuman: true,
        subject: `Task Failed: ${task.title}`,
        body: `Task "${task.title}" has failed after ${config.maxWorkerAttempts} worker recovery attempts.\n\nTask ID: ${taskId}\nEpic ID: ${task.epicId}\n\nManual intervention required.`,
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

    // Mark old worker as failed
    await agentAccessor.update(agentId, {
      state: AgentState.FAILED,
    });

    // Reset task for new worker
    await taskAccessor.update(taskId, {
      state: TaskState.PENDING,
      assignedAgentId: null,
      attempts,
    });

    logger.info('Worker recovery initiated', {
      oldWorkerId: agentId,
      taskId,
      attempt: attempts,
    });

    // Log the decision
    await decisionLogAccessor.createManual(
      agentId,
      `Worker crashed, task reset for recovery attempt ${attempts}`,
      'Worker became unresponsive or crashed',
      JSON.stringify({ taskId, attempts })
    );

    return {
      success: true,
      action: 'recovered',
      message: `Task reset for recovery (attempt ${attempts}/${config.maxWorkerAttempts})`,
    };
  }

  /**
   * Recover a crashed supervisor
   */
  private async recoverSupervisor(agentId: string, epicId?: string): Promise<RecoveryResult> {
    if (!epicId) {
      logger.warn('Cannot recover supervisor without epic ID', { agentId });
      return {
        success: false,
        action: 'no_action',
        message: 'No epic ID provided for supervisor recovery',
      };
    }

    const epic = await epicAccessor.findById(epicId);
    if (!epic) {
      return {
        success: false,
        action: 'no_action',
        message: `Epic ${epicId} not found`,
      };
    }

    // Mark old supervisor as failed
    await agentAccessor.update(agentId, {
      state: AgentState.FAILED,
      currentEpicId: null,
    });

    // Mark all active workers for this epic as needing recovery
    const tasks = await taskAccessor.list({ epicId });
    for (const task of tasks) {
      if (
        task.assignedAgentId &&
        (task.state === TaskState.IN_PROGRESS || task.state === TaskState.ASSIGNED)
      ) {
        // Mark worker's task as pending for reassignment
        await taskAccessor.update(task.id, {
          state: TaskState.PENDING,
          assignedAgentId: null,
        });

        // Mark worker as failed
        await agentAccessor.update(task.assignedAgentId, {
          state: AgentState.FAILED,
        });
      }
    }

    // Update epic state
    await epicAccessor.update(epicId, {
      state: EpicState.IN_PROGRESS, // Keep in progress for new supervisor
    });

    // Notify human
    await mailAccessor.create({
      isForHuman: true,
      subject: `Supervisor Crashed: ${epic.title}`,
      body: `The supervisor for epic "${epic.title}" has crashed.\n\nEpic ID: ${epicId}\n\nA new supervisor needs to be started. Active workers have been reset.`,
    });

    await notificationService.notifyCriticalError(
      'Supervisor',
      epic.title,
      'Supervisor crashed - new supervisor needed'
    );

    logger.info('Supervisor recovery initiated', {
      oldSupervisorId: agentId,
      epicId,
    });

    return {
      success: true,
      action: 'recovered',
      message: 'Supervisor marked as failed, epic ready for new supervisor',
    };
  }

  /**
   * Recover the orchestrator
   */
  private async recoverOrchestrator(agentId: string): Promise<RecoveryResult> {
    // Mark old orchestrator as failed
    await agentAccessor.update(agentId, {
      state: AgentState.FAILED,
    });

    // Notify human - orchestrator recovery is critical
    await mailAccessor.create({
      isForHuman: true,
      subject: 'CRITICAL: Orchestrator Crashed',
      body: `The system orchestrator has crashed.\n\nAgent ID: ${agentId}\n\nThe orchestrator needs to be manually restarted. All supervisors will continue running but may need health checks.`,
    });

    await notificationService.notifyCriticalError(
      'Orchestrator',
      undefined,
      'System orchestrator crashed - manual restart required'
    );

    logger.error('Orchestrator crashed, manual intervention required', {
      orchestratorId: agentId,
    });

    return {
      success: false, // Orchestrator can't auto-recover
      action: 'marked_failed',
      message: 'Orchestrator marked as failed, manual restart required',
    };
  }

  /**
   * Get system health status
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
      (o) => o.state === AgentState.BUSY || o.state === AgentState.IDLE
    );
    const orchestratorHealthy = !!activeOrchestrator;

    if (!orchestratorHealthy) {
      issues.push('No active orchestrator found');
    }

    // Get supervisor status
    const supervisors = await agentAccessor.findByType(AgentType.SUPERVISOR);
    const healthySupervisors = supervisors.filter((s) => s.state !== AgentState.FAILED);

    // Get worker status
    const workers = await agentAccessor.findByType(AgentType.WORKER);
    const healthyWorkers = workers.filter((w) => w.state !== AgentState.FAILED);

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
