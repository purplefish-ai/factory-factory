import { AgentType, ExecutionState } from '@prisma-gen/client';
import {
  checkSupervisorHealth,
  getPendingTopLevelTasksNeedingSupervisors,
  recoverSupervisor,
} from '../../agents/orchestrator/health.js';
import { startSupervisorForTask } from '../../agents/supervisor/lifecycle.js';
import {
  agentAccessor,
  decisionLogAccessor,
  mailAccessor,
} from '../../resource_accessors/index.js';
import { notificationService } from '../../services/notification.service.js';
import { inngest } from '../client.js';

interface RecoveryResult {
  supervisorId: string;
  taskId: string;
  taskTitle: string;
  success: boolean;
  newSupervisorId?: string;
  workersKilled: number;
  tasksReset: number;
  message: string;
}

interface UnhealthySupervisor {
  supervisorId: string;
  taskId: string;
  taskTitle: string;
  minutesSinceHeartbeat: number;
}

/**
 * Recover unhealthy supervisors and return results
 */
async function recoverUnhealthySupervisors(
  unhealthySupervisors: UnhealthySupervisor[],
  orchestratorId: string
): Promise<RecoveryResult[]> {
  const results: RecoveryResult[] = [];

  for (const unhealthy of unhealthySupervisors) {
    console.log(
      `Supervisor ${unhealthy.supervisorId} is unhealthy (${unhealthy.minutesSinceHeartbeat} minutes since heartbeat)`
    );

    const result = await attemptSupervisorRecovery(unhealthy, orchestratorId);
    results.push(result);
  }

  return results;
}

/**
 * Attempt to recover a single unhealthy supervisor
 */
interface PendingTopLevelTask {
  taskId: string;
  title: string;
}

interface NewSupervisorResult {
  taskId: string;
  taskTitle: string;
  supervisorId: string | null;
  success: boolean;
  error?: string;
}

/**
 * Create supervisors for pending top-level tasks
 */
async function createSupervisorsForPendingTopLevelTasks(
  pendingTasks: PendingTopLevelTask[],
  orchestratorId: string | null
): Promise<NewSupervisorResult[]> {
  const results: NewSupervisorResult[] = [];

  for (const task of pendingTasks) {
    const result = await createSupervisorForTopLevelTask(task, orchestratorId);
    results.push(result);
  }

  return results;
}

/**
 * Create a supervisor for a single pending top-level task
 */
async function createSupervisorForTopLevelTask(
  task: PendingTopLevelTask,
  orchestratorId: string | null
): Promise<NewSupervisorResult> {
  try {
    const supervisorId = await startSupervisorForTask(task.taskId);
    console.log(`Created supervisor ${supervisorId} for top-level task ${task.taskId}`);

    if (orchestratorId) {
      await decisionLogAccessor.createManual(
        orchestratorId,
        `Cron job: Created supervisor for pending top-level task "${task.title}"`,
        `Task was in PLANNING state without a supervisor`,
        JSON.stringify({ taskId: task.taskId, supervisorId })
      );
    }

    return { taskId: task.taskId, taskTitle: task.title, supervisorId, success: true };
  } catch (error) {
    console.error(`Failed to create supervisor for top-level task ${task.taskId}:`, error);

    await mailAccessor.create({
      isForHuman: true,
      subject: `Failed to create supervisor for top-level task: ${task.title}`,
      body:
        `The cron job failed to create a supervisor for top-level task "${task.title}".\n\n` +
        `Task ID: ${task.taskId}\n` +
        `Error: ${error instanceof Error ? error.message : String(error)}\n\n` +
        `Manual intervention may be required.`,
    });

    return {
      taskId: task.taskId,
      taskTitle: task.title,
      supervisorId: null,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Attempt to recover a single unhealthy supervisor
 */
async function attemptSupervisorRecovery(
  unhealthy: UnhealthySupervisor,
  orchestratorId: string
): Promise<RecoveryResult> {
  try {
    const recoveryResult = await recoverSupervisor(
      unhealthy.supervisorId,
      unhealthy.taskId,
      orchestratorId
    );

    await notificationService.notifyCriticalError(
      'Supervisor',
      unhealthy.taskTitle,
      recoveryResult.success
        ? `Recovered successfully. New supervisor: ${recoveryResult.newSupervisorId}`
        : `Recovery failed: ${recoveryResult.message}`
    );

    if (recoveryResult.success) {
      console.log(
        `Recovered supervisor: ${unhealthy.supervisorId} -> ${recoveryResult.newSupervisorId}`
      );
    } else {
      console.log(`Failed to recover supervisor ${unhealthy.supervisorId}`);
    }

    return {
      supervisorId: unhealthy.supervisorId,
      taskId: unhealthy.taskId,
      taskTitle: unhealthy.taskTitle,
      ...recoveryResult,
    };
  } catch (error) {
    console.error(`Failed to recover supervisor ${unhealthy.supervisorId}:`, error);

    await notificationService.notifyCriticalError(
      'Supervisor',
      unhealthy.taskTitle,
      `Recovery failed with error: ${error instanceof Error ? error.message : String(error)}`
    );

    return {
      supervisorId: unhealthy.supervisorId,
      taskId: unhealthy.taskId,
      taskTitle: unhealthy.taskTitle,
      success: false,
      workersKilled: 0,
      tasksReset: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Orchestrator Health Check Cron Job
 *
 * Runs every 2 minutes to:
 * 1. Check supervisor health and trigger cascading recovery if needed
 * 2. Check for pending top-level tasks that need supervisors
 *
 * This serves as a backup/failsafe for the in-process checks
 * that the orchestrator performs internally.
 *
 * Schedule: Every 2 minutes
 */
export const orchestratorCheckHandler = inngest.createFunction(
  {
    id: 'orchestrator-check',
    name: 'Orchestrator Supervisor Health Check',
    retries: 1,
  },
  { cron: '*/2 * * * *' }, // Every 2 minutes
  async ({ step }) => {
    console.log('Orchestrator check cron job started');

    // Step 1: Get the orchestrator agent (if one exists)
    const orchestrator = await step.run('get-orchestrator', async () => {
      const orchestrators = await agentAccessor.findByType(AgentType.ORCHESTRATOR);
      const activeOrchestrators = orchestrators.filter(
        (o) => o.executionState !== ExecutionState.CRASHED
      );

      if (activeOrchestrators.length === 0) {
        console.log('No active orchestrator found');
        return null;
      }

      const o = activeOrchestrators[0];
      return {
        id: o.id,
        executionState: o.executionState,
        lastHeartbeat: (o.lastHeartbeat ?? o.createdAt).toISOString(),
      };
    });

    // Use a placeholder ID for logging if no orchestrator exists
    const orchestratorId = orchestrator?.id || 'cron-job';

    // Step 2: Check supervisor health
    const healthCheckResult = await step.run('check-supervisor-health', async () => {
      const { healthySupervisors, unhealthySupervisors } =
        await checkSupervisorHealth(orchestratorId);

      console.log(
        `Supervisor health: ${healthySupervisors.length} healthy, ${unhealthySupervisors.length} unhealthy`
      );

      const recoveryResults = await recoverUnhealthySupervisors(
        unhealthySupervisors,
        orchestratorId
      );

      // Log health check if there were any unhealthy supervisors
      if (unhealthySupervisors.length > 0 && orchestrator) {
        await decisionLogAccessor.createManual(
          orchestrator.id,
          `Cron health check: ${unhealthySupervisors.length} unhealthy supervisor(s)`,
          `Recovered: ${recoveryResults.filter((r) => r.success).length}, Failed: ${recoveryResults.filter((r) => !r.success).length}`,
          JSON.stringify({
            healthyCount: healthySupervisors.length,
            unhealthyCount: unhealthySupervisors.length,
            recoveryResults,
          })
        );
      }

      return {
        healthyCount: healthySupervisors.length,
        unhealthyCount: unhealthySupervisors.length,
        recoveryResults,
      };
    });

    // Step 3: Check for pending top-level tasks that need supervisors
    const pendingTasksResult = await step.run('check-pending-top-level-tasks', async () => {
      const pendingTasks = await getPendingTopLevelTasksNeedingSupervisors();

      if (pendingTasks.length === 0) {
        return { pendingTasksProcessed: 0, newSupervisors: [] };
      }

      console.log(`Found ${pendingTasks.length} pending top-level task(s) needing supervisors`);

      const newSupervisors = await createSupervisorsForPendingTopLevelTasks(
        pendingTasks,
        orchestrator?.id || null
      );

      return {
        pendingTasksProcessed: pendingTasks.length,
        newSupervisors,
      };
    });

    // Calculate totals
    const totalRecovered = healthCheckResult.recoveryResults.filter((r) => r.success).length;
    const totalFailed = healthCheckResult.recoveryResults.filter((r) => !r.success).length;
    const totalNewSupervisors = pendingTasksResult.newSupervisors.filter((s) => s.success).length;

    console.log(
      `Orchestrator check complete. ` +
        `Supervisors: ${healthCheckResult.unhealthyCount} unhealthy, ${totalRecovered} recovered, ${totalFailed} failed. ` +
        `Pending top-level tasks: ${pendingTasksResult.pendingTasksProcessed} processed, ${totalNewSupervisors} new supervisors created.`
    );

    return {
      success: true,
      orchestratorId,
      healthCheck: {
        healthySupervisors: healthCheckResult.healthyCount,
        unhealthySupervisors: healthCheckResult.unhealthyCount,
        supervisorsRecovered: totalRecovered,
        supervisorRecoveryFailed: totalFailed,
      },
      pendingTopLevelTasks: {
        processed: pendingTasksResult.pendingTasksProcessed,
        supervisorsCreated: totalNewSupervisors,
        failures: pendingTasksResult.newSupervisors.filter((s) => !s.success).length,
      },
      details: {
        recoveryResults: healthCheckResult.recoveryResults,
        newSupervisors: pendingTasksResult.newSupervisors,
      },
    };
  }
);
