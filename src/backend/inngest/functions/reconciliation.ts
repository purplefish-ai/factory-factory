/**
 * Reconciliation Inngest Functions
 *
 * Implements the hybrid triggering strategy for reconciliation:
 * 1. Event-triggered: Immediate reconciliation after state changes
 * 2. Cron-triggered: Periodic reconciliation to catch drift
 */

import { reconciliationService } from '../../services/index.js';
import { inngest } from '../client.js';

/**
 * Periodic Reconciliation Cron Job
 *
 * Runs every 30 seconds to ensure system consistency.
 * This is the "backup" reconciliation that catches any drift
 * that wasn't handled by event-triggered reconciliation.
 *
 * Schedule: Every 30 seconds (using Inngest's 6-field cron syntax with seconds)
 * Format: second minute hour day-of-month month day-of-week
 */
export const reconciliationCronHandler = inngest.createFunction(
  {
    id: 'reconciliation-cron',
    name: 'Periodic Reconciliation',
    retries: 1,
    concurrency: {
      limit: 1, // Only one reconciliation at a time
    },
  },
  { cron: '*/30 * * * * *' }, // Every 30 seconds (Inngest supports sub-minute cron)
  async ({ step }) => {
    console.log('Periodic reconciliation started');

    const result = await step.run('reconcile-all', async () => {
      return await reconciliationService.reconcileAll();
    });

    console.log('Periodic reconciliation complete', {
      tasksReconciled: result.tasksReconciled,
      agentsReconciled: result.agentsReconciled,
      supervisorsCreated: result.supervisorsCreated,
      workersCreated: result.workersCreated,
      infrastructureCreated: result.infrastructureCreated,
      crashesDetected: result.crashesDetected,
      errorCount: result.errors.length,
    });

    return {
      success: result.success,
      summary: {
        tasksReconciled: result.tasksReconciled,
        agentsReconciled: result.agentsReconciled,
        supervisorsCreated: result.supervisorsCreated,
        workersCreated: result.workersCreated,
        infrastructureCreated: result.infrastructureCreated,
        crashesDetected: result.crashesDetected,
        errorCount: result.errors.length,
      },
    };
  }
);

/**
 * Event-Triggered Reconciliation
 *
 * Handles immediate reconciliation requests triggered by state changes.
 * This provides faster response than waiting for the cron job.
 */
export const reconciliationEventHandler = inngest.createFunction(
  {
    id: 'reconciliation-event',
    name: 'Event-Triggered Reconciliation',
    retries: 2,
    concurrency: {
      limit: 5, // Allow multiple concurrent event-triggered reconciliations
    },
  },
  { event: 'reconcile.requested' },
  async ({ event, step }) => {
    const { taskId, agentId, source } = event.data;

    console.log('Event-triggered reconciliation started', { taskId, agentId, source });

    // If specific task or agent is requested, reconcile just that entity
    if (taskId) {
      await step.run('reconcile-task', async () => {
        await reconciliationService.reconcileTask(taskId);
      });

      return {
        success: true,
        type: 'task',
        entityId: taskId,
        source,
      };
    }

    if (agentId) {
      await step.run('reconcile-agent', async () => {
        await reconciliationService.reconcileAgent(agentId);
      });

      return {
        success: true,
        type: 'agent',
        entityId: agentId,
        source,
      };
    }

    // If no specific entity, run full reconciliation
    const result = await step.run('reconcile-all', async () => {
      return await reconciliationService.reconcileAll();
    });

    return {
      success: result.success,
      type: 'full',
      source,
      summary: {
        tasksReconciled: result.tasksReconciled,
        agentsReconciled: result.agentsReconciled,
        supervisorsCreated: result.supervisorsCreated,
        workersCreated: result.workersCreated,
        infrastructureCreated: result.infrastructureCreated,
        crashesDetected: result.crashesDetected,
        errorCount: result.errors.length,
      },
    };
  }
);

/**
 * Helper function to trigger immediate reconciliation for a task
 */
export async function triggerTaskReconciliation(taskId: string): Promise<void> {
  try {
    await inngest.send({
      name: 'reconcile.requested',
      data: {
        taskId,
        source: 'event',
        timestamp: Date.now(),
      },
    });
  } catch (error) {
    console.log('Failed to trigger task reconciliation (Inngest may not be running):', error);
    // Fall back to direct reconciliation if Inngest is not available
    await reconciliationService.reconcileTask(taskId);
  }
}

/**
 * Helper function to trigger immediate reconciliation for an agent
 */
export async function triggerAgentReconciliation(agentId: string): Promise<void> {
  try {
    await inngest.send({
      name: 'reconcile.requested',
      data: {
        agentId,
        source: 'event',
        timestamp: Date.now(),
      },
    });
  } catch (error) {
    console.log('Failed to trigger agent reconciliation (Inngest may not be running):', error);
    // Fall back to direct reconciliation if Inngest is not available
    await reconciliationService.reconcileAgent(agentId);
  }
}

/**
 * Helper function to trigger full reconciliation
 */
export async function triggerFullReconciliation(
  source: 'event' | 'manual' = 'manual'
): Promise<void> {
  try {
    await inngest.send({
      name: 'reconcile.requested',
      data: {
        source,
        timestamp: Date.now(),
      },
    });
  } catch (error) {
    console.log('Failed to trigger full reconciliation (Inngest may not be running):', error);
    // Fall back to direct reconciliation if Inngest is not available
    await reconciliationService.reconcileAll();
  }
}
