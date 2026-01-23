import { AgentState, AgentType } from '@prisma/client';
import {
  checkSupervisorHealth,
  getPendingEpicsNeedingSupervisors,
  recoverSupervisor,
} from '../../agents/orchestrator/health.js';
import { startSupervisorForEpic } from '../../agents/supervisor/lifecycle.js';
import {
  agentAccessor,
  decisionLogAccessor,
  mailAccessor,
} from '../../resource_accessors/index.js';
import { notificationService } from '../../services/notification.service.js';
import { inngest } from '../client.js';

/**
 * Orchestrator Health Check Cron Job
 *
 * Runs every 2 minutes to:
 * 1. Check supervisor health and trigger cascading recovery if needed
 * 2. Check for pending epics that need supervisors
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
      const activeOrchestrators = orchestrators.filter((o) => o.state !== AgentState.FAILED);

      if (activeOrchestrators.length === 0) {
        console.log('No active orchestrator found');
        return null;
      }

      return {
        id: activeOrchestrators[0].id,
        state: activeOrchestrators[0].state,
        lastActiveAt: activeOrchestrators[0].lastActiveAt.toISOString(),
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

      const recoveryResults: Array<{
        supervisorId: string;
        epicId: string;
        epicTitle: string;
        success: boolean;
        newSupervisorId?: string;
        workersKilled: number;
        tasksReset: number;
        message: string;
      }> = [];

      // Recover unhealthy supervisors
      for (const unhealthy of unhealthySupervisors) {
        console.log(
          `Supervisor ${unhealthy.supervisorId} is unhealthy (${unhealthy.minutesSinceHeartbeat} minutes since heartbeat)`
        );

        try {
          const recoveryResult = await recoverSupervisor(
            unhealthy.supervisorId,
            unhealthy.epicId,
            orchestratorId
          );

          recoveryResults.push({
            supervisorId: unhealthy.supervisorId,
            epicId: unhealthy.epicId,
            epicTitle: unhealthy.epicTitle,
            ...recoveryResult,
          });

          // Send notification for supervisor crash
          await notificationService.notifyCriticalError(
            'Supervisor',
            unhealthy.epicTitle,
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
        } catch (error) {
          console.error(`Failed to recover supervisor ${unhealthy.supervisorId}:`, error);

          recoveryResults.push({
            supervisorId: unhealthy.supervisorId,
            epicId: unhealthy.epicId,
            epicTitle: unhealthy.epicTitle,
            success: false,
            workersKilled: 0,
            tasksReset: 0,
            message: error instanceof Error ? error.message : String(error),
          });

          // Send critical error notification
          await notificationService.notifyCriticalError(
            'Supervisor',
            unhealthy.epicTitle,
            `Recovery failed with error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

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

    // Step 3: Check for pending epics that need supervisors
    const pendingEpicsResult = await step.run('check-pending-epics', async () => {
      const pendingEpics = await getPendingEpicsNeedingSupervisors();

      if (pendingEpics.length === 0) {
        return { pendingEpicsProcessed: 0, newSupervisors: [] };
      }

      console.log(`Found ${pendingEpics.length} pending epic(s) needing supervisors`);

      const newSupervisors: Array<{
        epicId: string;
        epicTitle: string;
        supervisorId: string | null;
        success: boolean;
        error?: string;
      }> = [];

      for (const epic of pendingEpics) {
        try {
          const supervisorId = await startSupervisorForEpic(epic.epicId);
          console.log(`Created supervisor ${supervisorId} for epic ${epic.epicId}`);

          newSupervisors.push({
            epicId: epic.epicId,
            epicTitle: epic.title,
            supervisorId,
            success: true,
          });

          // Log decision
          if (orchestrator) {
            await decisionLogAccessor.createManual(
              orchestrator.id,
              `Cron job: Created supervisor for pending epic "${epic.title}"`,
              `Epic was in PLANNING state without a supervisor`,
              JSON.stringify({ epicId: epic.epicId, supervisorId })
            );
          }
        } catch (error) {
          console.error(`Failed to create supervisor for epic ${epic.epicId}:`, error);

          newSupervisors.push({
            epicId: epic.epicId,
            epicTitle: epic.title,
            supervisorId: null,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });

          // Notify human about failure
          await mailAccessor.create({
            isForHuman: true,
            subject: `Failed to create supervisor for epic: ${epic.title}`,
            body:
              `The cron job failed to create a supervisor for epic "${epic.title}".\n\n` +
              `Epic ID: ${epic.epicId}\n` +
              `Error: ${error instanceof Error ? error.message : String(error)}\n\n` +
              `Manual intervention may be required.`,
          });
        }
      }

      return {
        pendingEpicsProcessed: pendingEpics.length,
        newSupervisors,
      };
    });

    // Calculate totals
    const totalRecovered = healthCheckResult.recoveryResults.filter((r) => r.success).length;
    const totalFailed = healthCheckResult.recoveryResults.filter((r) => !r.success).length;
    const totalNewSupervisors = pendingEpicsResult.newSupervisors.filter((s) => s.success).length;

    console.log(
      `Orchestrator check complete. ` +
        `Supervisors: ${healthCheckResult.unhealthyCount} unhealthy, ${totalRecovered} recovered, ${totalFailed} failed. ` +
        `Pending epics: ${pendingEpicsResult.pendingEpicsProcessed} processed, ${totalNewSupervisors} new supervisors created.`
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
      pendingEpics: {
        processed: pendingEpicsResult.pendingEpicsProcessed,
        supervisorsCreated: totalNewSupervisors,
        failures: pendingEpicsResult.newSupervisors.filter((s) => !s.success).length,
      },
      details: {
        recoveryResults: healthCheckResult.recoveryResults,
        newSupervisors: pendingEpicsResult.newSupervisors,
      },
    };
  }
);
