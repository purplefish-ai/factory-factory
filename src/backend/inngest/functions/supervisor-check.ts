import { AgentState, AgentType } from '@prisma-gen/client';
import { checkWorkerHealth, recoverWorker } from '../../agents/supervisor/health.js';
import {
  agentAccessor,
  decisionLogAccessor,
  mailAccessor,
} from '../../resource_accessors/index.js';
import { notificationService } from '../../services/notification.service.js';
import { inngest } from '../client.js';

interface SupervisorInfo {
  id: string;
  epicId: string;
  state: string;
  lastActiveAt: string;
}

interface WorkerHealthResult {
  supervisorId: string;
  epicId: string;
  healthyCount: number;
  unhealthyCount: number;
  recoveredWorkers: string[];
  failedRecoveries: string[];
}

interface UnhealthyWorkerInfo {
  workerId: string;
  taskId: string;
  minutesSinceHeartbeat: number;
}

/**
 * Recover unhealthy workers for a supervisor
 */
async function recoverUnhealthyWorkers(
  unhealthyWorkers: UnhealthyWorkerInfo[],
  supervisorId: string
): Promise<{ recovered: string[]; failed: string[] }> {
  const recovered: string[] = [];
  const failed: string[] = [];

  for (const unhealthy of unhealthyWorkers) {
    console.log(
      `Worker ${unhealthy.workerId} is unhealthy (${unhealthy.minutesSinceHeartbeat} minutes since heartbeat)`
    );

    try {
      const result = await recoverWorker(unhealthy.workerId, unhealthy.taskId, supervisorId);

      if (result.success && result.newWorkerId) {
        recovered.push(result.newWorkerId);
        console.log(`Recovered worker: ${unhealthy.workerId} -> ${result.newWorkerId}`);
      } else if (result.permanentFailure) {
        failed.push(unhealthy.workerId);
        console.log(`Worker ${unhealthy.workerId} permanently failed after max attempts`);
        await notificationService.notifyTaskFailed(
          `Task for worker ${unhealthy.workerId}`,
          `Worker failed after ${result.attemptNumber} recovery attempts`
        );
      } else {
        failed.push(unhealthy.workerId);
      }
    } catch (error) {
      console.error(`Failed to recover worker ${unhealthy.workerId}:`, error);
      failed.push(unhealthy.workerId);
    }
  }

  return { recovered, failed };
}

/**
 * Check workers for a single supervisor
 */
async function checkSupervisorWorkers(supervisor: SupervisorInfo): Promise<WorkerHealthResult> {
  try {
    console.log(`Checking workers for supervisor ${supervisor.id} (epic: ${supervisor.epicId})`);

    const { healthyWorkers, unhealthyWorkers } = await checkWorkerHealth(supervisor.id);
    const { recovered, failed } = await recoverUnhealthyWorkers(unhealthyWorkers, supervisor.id);

    if (unhealthyWorkers.length > 0) {
      await decisionLogAccessor.createManual(
        supervisor.id,
        `Cron health check: ${unhealthyWorkers.length} unhealthy worker(s)`,
        `Recovered: ${recovered.length}, Failed: ${failed.length}`,
        JSON.stringify({
          healthyCount: healthyWorkers.length,
          unhealthyCount: unhealthyWorkers.length,
          recoveredWorkers: recovered,
          failedRecoveries: failed,
        })
      );
    }

    return {
      supervisorId: supervisor.id,
      epicId: supervisor.epicId,
      healthyCount: healthyWorkers.length,
      unhealthyCount: unhealthyWorkers.length,
      recoveredWorkers: recovered,
      failedRecoveries: failed,
    };
  } catch (error) {
    console.error(`Error checking supervisor ${supervisor.id}:`, error);

    await mailAccessor.create({
      isForHuman: true,
      subject: `Health check failed for supervisor ${supervisor.id}`,
      body:
        `The cron job failed to check worker health for supervisor ${supervisor.id}.\n\n` +
        `Epic ID: ${supervisor.epicId}\n` +
        `Error: ${error instanceof Error ? error.message : String(error)}\n\n` +
        `Manual investigation may be required.`,
    });

    return {
      supervisorId: supervisor.id,
      epicId: supervisor.epicId,
      healthyCount: 0,
      unhealthyCount: 0,
      recoveredWorkers: [],
      failedRecoveries: [],
    };
  }
}

/**
 * Supervisor Health Check Cron Job
 *
 * Runs every 2 minutes to check worker health for all active supervisors.
 * This serves as a backup/failsafe for the in-process health checks
 * that supervisors perform internally.
 *
 * Schedule: Every 2 minutes
 */
export const supervisorCheckHandler = inngest.createFunction(
  {
    id: 'supervisor-check',
    name: 'Supervisor Worker Health Check',
    retries: 1,
  },
  { cron: '*/2 * * * *' }, // Every 2 minutes
  async ({ step }) => {
    console.log('Supervisor check cron job started');

    // Step 1: Get all active supervisors
    const activeSupervisors = await step.run('get-active-supervisors', async () => {
      const supervisors = await agentAccessor.findByType(AgentType.SUPERVISOR);

      // Filter to only active (non-failed) supervisors with epics
      const active = supervisors.filter(
        (s): s is typeof s & { currentEpicId: string } =>
          s.state !== AgentState.FAILED && s.currentEpicId !== null
      );

      console.log(`Found ${active.length} active supervisor(s)`);

      return active.map((s) => ({
        id: s.id,
        epicId: s.currentEpicId,
        state: s.state,
        lastActiveAt: s.lastActiveAt.toISOString(),
      }));
    });

    if (activeSupervisors.length === 0) {
      console.log('No active supervisors to check');
      return {
        success: true,
        supervisorsChecked: 0,
        workersRecovered: 0,
        message: 'No active supervisors',
      };
    }

    // Step 2: Check worker health for each supervisor
    const results = await step.run('check-all-supervisors', async () => {
      return Promise.all(activeSupervisors.map((supervisor) => checkSupervisorWorkers(supervisor)));
    });

    // Calculate totals
    const totalRecovered = results.reduce((sum, r) => sum + r.recoveredWorkers.length, 0);
    const totalFailed = results.reduce((sum, r) => sum + r.failedRecoveries.length, 0);
    const totalUnhealthy = results.reduce((sum, r) => sum + r.unhealthyCount, 0);

    console.log(
      `Supervisor check complete. Checked: ${activeSupervisors.length}, ` +
        `Unhealthy workers: ${totalUnhealthy}, Recovered: ${totalRecovered}, Failed: ${totalFailed}`
    );

    return {
      success: true,
      supervisorsChecked: activeSupervisors.length,
      totalUnhealthyWorkers: totalUnhealthy,
      workersRecovered: totalRecovered,
      workerRecoveryFailed: totalFailed,
      details: results,
    };
  }
);
