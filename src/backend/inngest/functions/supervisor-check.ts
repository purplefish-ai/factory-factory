import { AgentType, AgentState } from '@prisma/client';
import { inngest } from '../client.js';
import {
  agentAccessor,
  decisionLogAccessor,
  mailAccessor,
} from '../../resource_accessors/index.js';
import { checkWorkerHealth, recoverWorker } from '../../agents/supervisor/health.js';
import { notificationService } from '../../services/notification.service.js';

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

      // Filter to only active (non-failed) supervisors
      const active = supervisors.filter(
        (s) => s.state !== AgentState.FAILED && s.currentEpicId !== null
      );

      console.log(`Found ${active.length} active supervisor(s)`);

      return active.map((s) => ({
        id: s.id,
        epicId: s.currentEpicId!,
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
      const results: Array<{
        supervisorId: string;
        epicId: string;
        healthyCount: number;
        unhealthyCount: number;
        recoveredWorkers: string[];
        failedRecoveries: string[];
      }> = [];

      for (const supervisor of activeSupervisors) {
        try {
          console.log(`Checking workers for supervisor ${supervisor.id} (epic: ${supervisor.epicId})`);

          const { healthyWorkers, unhealthyWorkers } = await checkWorkerHealth(supervisor.id);

          const recoveredWorkers: string[] = [];
          const failedRecoveries: string[] = [];

          // Recover unhealthy workers
          for (const unhealthy of unhealthyWorkers) {
            console.log(
              `Worker ${unhealthy.workerId} is unhealthy (${unhealthy.minutesSinceHeartbeat} minutes since heartbeat)`
            );

            try {
              const recoveryResult = await recoverWorker(
                unhealthy.workerId,
                unhealthy.taskId,
                supervisor.id
              );

              if (recoveryResult.success && recoveryResult.newWorkerId) {
                recoveredWorkers.push(recoveryResult.newWorkerId);
                console.log(`Recovered worker: ${unhealthy.workerId} -> ${recoveryResult.newWorkerId}`);
              } else if (recoveryResult.permanentFailure) {
                failedRecoveries.push(unhealthy.workerId);
                console.log(`Worker ${unhealthy.workerId} permanently failed after max attempts`);

                // Send notification for permanent failure
                await notificationService.notifyTaskFailed(
                  `Task for worker ${unhealthy.workerId}`,
                  `Worker failed after ${recoveryResult.attemptNumber} recovery attempts`
                );
              } else {
                failedRecoveries.push(unhealthy.workerId);
              }
            } catch (error) {
              console.error(`Failed to recover worker ${unhealthy.workerId}:`, error);
              failedRecoveries.push(unhealthy.workerId);
            }
          }

          results.push({
            supervisorId: supervisor.id,
            epicId: supervisor.epicId,
            healthyCount: healthyWorkers.length,
            unhealthyCount: unhealthyWorkers.length,
            recoveredWorkers,
            failedRecoveries,
          });

          // Log the health check
          if (unhealthyWorkers.length > 0) {
            await decisionLogAccessor.createManual(
              supervisor.id,
              `Cron health check: ${unhealthyWorkers.length} unhealthy worker(s)`,
              `Recovered: ${recoveredWorkers.length}, Failed: ${failedRecoveries.length}`,
              JSON.stringify({
                healthyCount: healthyWorkers.length,
                unhealthyCount: unhealthyWorkers.length,
                recoveredWorkers,
                failedRecoveries,
              })
            );
          }
        } catch (error) {
          console.error(`Error checking supervisor ${supervisor.id}:`, error);

          // Notify human about health check failure
          await mailAccessor.create({
            isForHuman: true,
            subject: `Health check failed for supervisor ${supervisor.id}`,
            body: `The cron job failed to check worker health for supervisor ${supervisor.id}.\n\n` +
              `Epic ID: ${supervisor.epicId}\n` +
              `Error: ${error instanceof Error ? error.message : String(error)}\n\n` +
              `Manual investigation may be required.`,
          });
        }
      }

      return results;
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
