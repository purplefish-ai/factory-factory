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
  mailAccessor,
  taskAccessor,
} from '../../resource_accessors/index.js';
import { killSupervisorAndCleanup, startSupervisorForTask } from '../supervisor/lifecycle.js';
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
    taskId: string;
    taskTitle: string;
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
    taskId: string;
    taskTitle: string;
    minutesSinceHeartbeat: number;
  }> = [];

  for (const supervisor of supervisors) {
    if (!supervisor.currentTaskId) {
      continue;
    }

    const task = await taskAccessor.findById(supervisor.currentTaskId);
    const taskTitle = task?.title || 'Unknown';

    if (supervisor.isHealthy) {
      healthySupervisors.push(supervisor.id);
    } else {
      unhealthySupervisors.push({
        supervisorId: supervisor.id,
        taskId: supervisor.currentTaskId,
        taskTitle,
        minutesSinceHeartbeat: supervisor.minutesSinceHeartbeat,
      });
    }
  }

  return { healthySupervisors, unhealthySupervisors };
}

/**
 * Kill all workers for a top-level task and mark them as failed
 */
async function killWorkersForTopLevelTask(topLevelTaskId: string): Promise<string[]> {
  const workers = await agentAccessor.findWorkersByTopLevelTaskId(topLevelTaskId);
  const killedWorkerIds: string[] = [];

  for (const worker of workers) {
    try {
      await killWorkerAndCleanup(worker.id);
      killedWorkerIds.push(worker.id);
    } catch (error) {
      console.error(`Failed to kill worker ${worker.id}:`, error);
    }

    try {
      await agentAccessor.update(worker.id, { state: AgentState.FAILED });
    } catch (error) {
      console.error(`Failed to update worker ${worker.id} state:`, error);
    }
  }

  return killedWorkerIds;
}

/**
 * Kill a supervisor and mark it as failed
 */
async function killSupervisorAgent(supervisorId: string): Promise<void> {
  try {
    await killSupervisorAndCleanup(supervisorId);
  } catch (error) {
    console.error(`Failed to kill supervisor ${supervisorId}:`, error);
  }

  try {
    await agentAccessor.update(supervisorId, {
      state: AgentState.FAILED,
      currentTaskId: null,
    });
  } catch (error) {
    console.error(`Failed to update supervisor ${supervisorId} state:`, error);
  }
}

/**
 * Reset non-terminal tasks to PENDING state
 */
async function resetTasksForTopLevelTask(
  topLevelTaskId: string
): Promise<{ resetIds: string[]; totalCount: number }> {
  const tasks = await taskAccessor.findByParentId(topLevelTaskId);
  const resetTaskIds: string[] = [];

  for (const task of tasks) {
    if (task.state === TaskState.COMPLETED || task.state === TaskState.FAILED) {
      continue;
    }

    try {
      await taskAccessor.update(task.id, {
        state: TaskState.PENDING,
        assignedAgentId: null,
        attempts: 0,
        failureReason: null,
      });
      resetTaskIds.push(task.id);
    } catch (error) {
      console.error(`Failed to reset task ${task.id}:`, error);
    }
  }

  return { resetIds: resetTaskIds, totalCount: tasks.length };
}

/**
 * Create a new supervisor for a top-level task
 * If resumeSessionId is provided, the new supervisor will resume the Claude conversation
 */
async function createNewSupervisor(
  topLevelTaskId: string,
  resumeSessionId?: string
): Promise<string | null> {
  try {
    const supervisorId = await startSupervisorForTask(topLevelTaskId, {
      resumeSessionId,
    });
    console.log(
      `Created new supervisor ${supervisorId}${resumeSessionId ? ` (resuming session ${resumeSessionId})` : ''}`
    );
    return supervisorId;
  } catch (error) {
    console.error(`Failed to create new supervisor for task ${topLevelTaskId}:`, error);
    return null;
  }
}

/**
 * Perform cascading recovery for a crashed supervisor
 *
 * This performs the full cascading recovery:
 * 1. Kill all workers for the top-level task
 * 2. Kill the supervisor
 * 3. Reset task states (non-completed tasks back to PENDING)
 * 4. Create new supervisor
 * 5. Notify human
 *
 * @param supervisorId - The ID of the crashed supervisor
 * @param taskId - The ID of the top-level task the supervisor was managing
 * @param orchestratorId - The ID of the orchestrator triggering recovery
 * @returns Recovery result
 */
export async function recoverSupervisor(
  supervisorId: string,
  taskId: string,
  orchestratorId: string
): Promise<{
  success: boolean;
  newSupervisorId?: string;
  workersKilled: number;
  tasksReset: number;
  message: string;
}> {
  const task = await taskAccessor.findById(taskId);
  if (!task) {
    return { success: false, workersKilled: 0, tasksReset: 0, message: `Task ${taskId} not found` };
  }

  // Validate orchestrator exists before using it as fromAgentId
  const orchestrator = await agentAccessor.findById(orchestratorId);
  const validOrchestratorId = orchestrator ? orchestratorId : undefined;

  // Get the old session ID before killing the supervisor (for resume capability)
  const oldSupervisor = await agentAccessor.findById(supervisorId);
  const oldSessionId = oldSupervisor?.sessionId;

  if (oldSessionId) {
    console.log(`Supervisor ${supervisorId} has session ID ${oldSessionId}, will attempt resume`);
  }

  console.log(`Starting cascading recovery for supervisor ${supervisorId} (task: ${task.title})`);

  // Phase 1: Kill workers
  const killedWorkerIds = await killWorkersForTopLevelTask(taskId);
  console.log(`Killed ${killedWorkerIds.length} workers`);

  // Phase 2: Kill supervisor
  await killSupervisorAgent(supervisorId);
  console.log(`Killed supervisor ${supervisorId}`);

  // Phase 3: Reset tasks
  const { resetIds: resetTaskIds, totalCount: totalTasks } =
    await resetTasksForTopLevelTask(taskId);
  console.log(`Reset ${resetTaskIds.length} tasks to PENDING`);

  // Phase 4: Create new supervisor with resume capability if old session ID exists
  // This preserves conversation history and context from the crashed session
  const newSupervisorId = await createNewSupervisor(taskId, oldSessionId ?? undefined);

  // Phase 5: Notify and log
  await mailAccessor.create({
    fromAgentId: validOrchestratorId,
    isForHuman: true,
    subject: `Supervisor Crashed and Recovered - Task: ${task.title}`,
    body: `A supervisor crash was detected and cascading recovery was performed.

**Task**: ${task.title}
**Task ID**: ${taskId}

**Recovery Summary**:
- Old Supervisor: ${supervisorId} (killed)
- New Supervisor: ${newSupervisorId || 'FAILED TO CREATE'}
- Workers killed: ${killedWorkerIds.length}
- Tasks reset to PENDING: ${resetTaskIds.length}
- Tasks kept (COMPLETED/FAILED): ${totalTasks - resetTaskIds.length}

${
  newSupervisorId
    ? 'The new supervisor will resume work on pending tasks automatically.'
    : 'WARNING: Failed to create new supervisor. Manual intervention required.'
}`,
  });

  await decisionLogAccessor.createManual(
    orchestratorId,
    `Supervisor crashed - cascading recovery performed`,
    `Supervisor ${supervisorId} became unresponsive. Killed ${killedWorkerIds.length} workers, reset ${resetTaskIds.length} tasks, created new supervisor ${newSupervisorId || 'FAILED'}`,
    JSON.stringify({
      taskId,
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
 * Get health summary for all supervisors
 */
export async function getSupervisorHealthSummary(): Promise<{
  totalSupervisors: number;
  healthySupervisors: number;
  unhealthySupervisors: number;
  supervisors: Array<{
    supervisorId: string;
    taskId: string | null;
    taskTitle: string;
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
      const task = s.currentTaskId ? await taskAccessor.findById(s.currentTaskId) : null;

      return {
        supervisorId: s.id,
        taskId: s.currentTaskId,
        taskTitle: task?.title || 'No task',
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
 * Check for pending top-level tasks that need supervisors
 * This is used by the orchestrator to create supervisors for new top-level tasks
 */
export async function getPendingTopLevelTasksNeedingSupervisors(): Promise<
  Array<{
    taskId: string;
    title: string;
    createdAt: Date;
  }>
> {
  const topLevelTasks = await taskAccessor.findTopLevel();
  const pendingTasks: Array<{
    taskId: string;
    title: string;
    createdAt: Date;
  }> = [];

  for (const task of topLevelTasks) {
    // Only consider tasks in PLANNING state
    if (task.state !== TaskState.PLANNING) {
      continue;
    }

    // Check if task already has a supervisor
    const supervisor = await agentAccessor.findByTaskId(task.id);
    if (supervisor) {
      continue;
    }

    pendingTasks.push({
      taskId: task.id,
      title: task.title,
      createdAt: task.createdAt,
    });
  }

  return pendingTasks;
}
