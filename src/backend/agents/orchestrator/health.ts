/**
 * Orchestrator Health Monitoring
 *
 * This module handles supervisor crash detection and cascading recovery from the orchestrator's perspective.
 * The orchestrator periodically checks supervisor health and triggers cascading recovery when needed.
 */

import { AgentState, AgentType, TaskState } from '@prisma-gen/client';
import {
  agentAccessor,
  decisionLogAccessor,
  epicAccessor,
  mailAccessor,
  taskAccessor,
} from '../../resource_accessors/index.js';
import { killSupervisorAndCleanup, startSupervisorForEpic } from '../supervisor/lifecycle.js';
import { killWorkerAndCleanup } from '../worker/lifecycle.js';

/**
 * Health threshold in minutes - supervisors not heard from in this time are unhealthy
 */
const SUPERVISOR_HEALTH_THRESHOLD_MINUTES = 7;

/**
 * Check health of all supervisors
 * Returns list of unhealthy supervisors
 */
export async function checkSupervisorHealth(_orchestratorId: string): Promise<{
  healthySupervisors: string[];
  unhealthySupervisors: Array<{
    supervisorId: string;
    epicId: string;
    epicTitle: string;
    minutesSinceHeartbeat: number;
  }>;
}> {
  // Get all supervisors with health status
  const supervisors = await agentAccessor.getAgentsWithHealthStatus(
    AgentType.SUPERVISOR,
    SUPERVISOR_HEALTH_THRESHOLD_MINUTES
  );

  const healthySupervisors: string[] = [];
  const unhealthySupervisors: Array<{
    supervisorId: string;
    epicId: string;
    epicTitle: string;
    minutesSinceHeartbeat: number;
  }> = [];

  for (const supervisor of supervisors) {
    if (!supervisor.currentEpicId) {
      continue;
    }

    const epic = await epicAccessor.findById(supervisor.currentEpicId);
    const epicTitle = epic?.title || 'Unknown';

    if (supervisor.isHealthy) {
      healthySupervisors.push(supervisor.id);
    } else {
      unhealthySupervisors.push({
        supervisorId: supervisor.id,
        epicId: supervisor.currentEpicId,
        epicTitle,
        minutesSinceHeartbeat: supervisor.minutesSinceHeartbeat,
      });
    }
  }

  return { healthySupervisors, unhealthySupervisors };
}

/**
 * Perform cascading recovery for a crashed supervisor
 *
 * This performs the full cascading recovery:
 * 1. Kill all workers for the epic
 * 2. Kill the supervisor
 * 3. Reset task states (non-completed tasks back to PENDING)
 * 4. Create new supervisor
 * 5. Notify human
 *
 * @param supervisorId - The ID of the crashed supervisor
 * @param epicId - The ID of the epic the supervisor was managing
 * @param orchestratorId - The ID of the orchestrator triggering recovery
 * @returns Recovery result
 */
export async function recoverSupervisor(
  supervisorId: string,
  epicId: string,
  orchestratorId: string
): Promise<{
  success: boolean;
  newSupervisorId?: string;
  workersKilled: number;
  tasksReset: number;
  message: string;
}> {
  // Get epic for notifications
  const epic = await epicAccessor.findById(epicId);
  if (!epic) {
    return {
      success: false,
      workersKilled: 0,
      tasksReset: 0,
      message: `Epic ${epicId} not found`,
    };
  }

  console.log(`Starting cascading recovery for supervisor ${supervisorId} (epic: ${epic.title})`);

  // ========================================================================
  // Phase 1: Kill all workers for this epic
  // ========================================================================
  const workers = await agentAccessor.findWorkersByEpicId(epicId);
  const killedWorkerIds: string[] = [];

  for (const worker of workers) {
    try {
      await killWorkerAndCleanup(worker.id);
      killedWorkerIds.push(worker.id);
    } catch (error) {
      console.error(`Failed to kill worker ${worker.id}:`, error);
      // Continue with other workers
    }

    // Mark worker as FAILED
    try {
      await agentAccessor.update(worker.id, {
        state: AgentState.FAILED,
      });
    } catch (error) {
      console.error(`Failed to update worker ${worker.id} state:`, error);
    }
  }

  console.log(`Killed ${killedWorkerIds.length} workers`);

  // ========================================================================
  // Phase 2: Kill the supervisor
  // ========================================================================
  try {
    await killSupervisorAndCleanup(supervisorId);
  } catch (error) {
    console.error(`Failed to kill supervisor ${supervisorId}:`, error);
    // Continue anyway
  }

  // Mark supervisor as FAILED and clear its epic assignment
  // (this allows a new supervisor to be created for the epic)
  try {
    await agentAccessor.update(supervisorId, {
      state: AgentState.FAILED,
      currentEpicId: null,
    });
  } catch (error) {
    console.error(`Failed to update supervisor ${supervisorId} state:`, error);
  }

  console.log(`Killed supervisor ${supervisorId}`);

  // ========================================================================
  // Phase 3: Reset task states
  // ========================================================================
  const tasks = await taskAccessor.list({ epicId });
  const resetTaskIds: string[] = [];

  for (const task of tasks) {
    // Keep COMPLETED and FAILED tasks as-is
    if (task.state === TaskState.COMPLETED || task.state === TaskState.FAILED) {
      continue;
    }

    // Reset all other states (PENDING_REVIEW, NEEDS_REBASE, IN_PROGRESS, APPROVED, BLOCKED, ASSIGNED, REVIEW) to PENDING
    try {
      await taskAccessor.update(task.id, {
        state: TaskState.PENDING,
        assignedAgentId: null, // Clear worker assignment
        attempts: 0, // Reset attempt counter for cascading recovery
        failureReason: null,
      });
      resetTaskIds.push(task.id);
    } catch (error) {
      console.error(`Failed to reset task ${task.id}:`, error);
    }
  }

  console.log(`Reset ${resetTaskIds.length} tasks to PENDING`);

  // ========================================================================
  // Phase 4: Create new supervisor
  // ========================================================================
  let newSupervisorId: string | null = null;
  try {
    newSupervisorId = await startSupervisorForEpic(epicId);
    console.log(`Created new supervisor ${newSupervisorId}`);
  } catch (error) {
    console.error(`Failed to create new supervisor for epic ${epicId}:`, error);
    // Continue to notification phase even if supervisor creation fails
  }

  // ========================================================================
  // Phase 5: Notify human
  // ========================================================================
  await mailAccessor.create({
    fromAgentId: orchestratorId,
    isForHuman: true,
    subject: `Supervisor Crashed and Recovered - Epic: ${epic.title}`,
    body: `A supervisor crash was detected and cascading recovery was performed.

**Epic**: ${epic.title}
**Epic ID**: ${epicId}

**Recovery Summary**:
- Old Supervisor: ${supervisorId} (killed)
- New Supervisor: ${newSupervisorId || 'FAILED TO CREATE'}
- Workers killed: ${killedWorkerIds.length}
- Tasks reset to PENDING: ${resetTaskIds.length}
- Tasks kept (COMPLETED/FAILED): ${tasks.length - resetTaskIds.length}

${
  newSupervisorId
    ? 'The new supervisor will resume work on pending tasks automatically.'
    : '⚠️ WARNING: Failed to create new supervisor. Manual intervention required.'
}`,
  });

  // Log decision
  await decisionLogAccessor.createManual(
    orchestratorId,
    `Supervisor crashed - cascading recovery performed`,
    `Supervisor ${supervisorId} became unresponsive. Killed ${killedWorkerIds.length} workers, reset ${resetTaskIds.length} tasks, created new supervisor ${newSupervisorId || 'FAILED'}`,
    JSON.stringify({
      epicId,
      oldSupervisorId: supervisorId,
      newSupervisorId,
      workersKilled: killedWorkerIds,
      tasksReset: resetTaskIds,
    })
  );

  if (!newSupervisorId) {
    return {
      success: false,
      workersKilled: killedWorkerIds.length,
      tasksReset: resetTaskIds.length,
      message: `Cascading recovery partially complete. Workers killed and tasks reset, but failed to create new supervisor.`,
    };
  }

  return {
    success: true,
    newSupervisorId,
    workersKilled: killedWorkerIds.length,
    tasksReset: resetTaskIds.length,
    message: `Cascading recovery complete. New supervisor ${newSupervisorId} created.`,
  };
}

/**
 * Send health check mail to a supervisor
 * Used to proactively check if a supervisor is still active
 */
export async function sendSupervisorHealthCheck(
  orchestratorId: string,
  supervisorId: string,
  epicId: string
): Promise<void> {
  const epic = await epicAccessor.findById(epicId);
  const epicTitle = epic?.title || 'Unknown epic';

  await mailAccessor.create({
    fromAgentId: orchestratorId,
    toAgentId: supervisorId,
    subject: 'Health Check - Please confirm you are active',
    body: `This is a health check from the orchestrator.\n\nPlease confirm you are still active by replying to this message with your current status.\n\nEpic: ${epicTitle}\nEpic ID: ${epicId}\n\nIf you don't respond within 7 minutes, you may be marked as unresponsive and recovered.`,
  });

  console.log(`Sent health check to supervisor ${supervisorId} for epic ${epicId}`);
}

/**
 * Get health summary for all supervisors
 */
export async function getSupervisorHealthSummary(): Promise<{
  totalSupervisors: number;
  healthySupervisors: number;
  unhealthySupervisors: number;
  supervisors: Array<{
    supervisorId: string;
    epicId: string | null;
    epicTitle: string;
    state: string;
    isHealthy: boolean;
    minutesSinceHeartbeat: number;
  }>;
}> {
  const supervisors = await agentAccessor.getAgentsWithHealthStatus(
    AgentType.SUPERVISOR,
    SUPERVISOR_HEALTH_THRESHOLD_MINUTES
  );

  const supervisorDetails = await Promise.all(
    supervisors.map(async (s) => {
      const epic = s.currentEpicId ? await epicAccessor.findById(s.currentEpicId) : null;

      return {
        supervisorId: s.id,
        epicId: s.currentEpicId,
        epicTitle: epic?.title || 'No epic',
        state: s.state,
        isHealthy: s.isHealthy,
        minutesSinceHeartbeat: s.minutesSinceHeartbeat,
      };
    })
  );

  return {
    totalSupervisors: supervisorDetails.length,
    healthySupervisors: supervisorDetails.filter((s) => s.isHealthy).length,
    unhealthySupervisors: supervisorDetails.filter((s) => !s.isHealthy).length,
    supervisors: supervisorDetails,
  };
}

/**
 * Check for pending epics that need supervisors
 * This is used by the orchestrator to create supervisors for new epics
 */
export async function getPendingEpicsNeedingSupervisors(): Promise<
  Array<{
    epicId: string;
    title: string;
    createdAt: Date;
  }>
> {
  const epics = await epicAccessor.list();
  const pendingEpics: Array<{
    epicId: string;
    title: string;
    createdAt: Date;
  }> = [];

  for (const epic of epics) {
    // Only consider epics in PLANNING state
    if (epic.state !== 'PLANNING') {
      continue;
    }

    // Check if epic already has a supervisor
    const supervisor = await agentAccessor.findByEpicId(epic.id);
    if (supervisor) {
      continue;
    }

    pendingEpics.push({
      epicId: epic.id,
      title: epic.title,
      createdAt: epic.createdAt,
    });
  }

  return pendingEpics;
}
