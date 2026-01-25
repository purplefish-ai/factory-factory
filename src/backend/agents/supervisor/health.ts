/**
 * Supervisor Health Monitoring
 *
 * This module handles worker crash detection and recovery from the supervisor's perspective.
 * The supervisor periodically checks worker health and triggers recovery when needed.
 */

import type { Agent } from '@prisma-gen/client';
import { CliProcessStatus, ExecutionState, TaskState } from '@prisma-gen/client';
import {
  agentAccessor,
  decisionLogAccessor,
  mailAccessor,
  taskAccessor,
} from '../../resource_accessors/index.js';
import { agentProcessAdapter } from '../process-adapter.js';
import { killWorkerAndCleanup, startWorker } from '../worker/lifecycle.js';

/**
 * Health threshold in minutes - workers not heard from in this time are unhealthy
 */
const WORKER_HEALTH_THRESHOLD_MINUTES = 7;

/**
 * Maximum number of recovery attempts before failing a task permanently
 */
const MAX_WORKER_ATTEMPTS = 5;

/**
 * Worker health status with extended information
 */
interface UnhealthyWorkerInfo {
  workerId: string;
  taskId: string;
  minutesSinceHeartbeat: number;
  reason: 'stale_heartbeat' | 'crashed_state' | 'process_not_running' | 'process_crashed';
  cliProcessStatus?: CliProcessStatus | null;
}

/**
 * Check health of all workers for a supervisor's top-level task
 * Returns list of unhealthy workers with detailed reasons
 *
 * Checks multiple indicators:
 * 1. CLI process status (CRASHED, KILLED, EXITED)
 * 2. Whether process is actually running via agentProcessAdapter
 * 3. Heartbeat staleness
 * 4. ExecutionState.CRASHED in database
 */
export async function checkWorkerHealth(supervisorId: string): Promise<{
  healthyWorkers: string[];
  unhealthyWorkers: UnhealthyWorkerInfo[];
}> {
  const supervisor = await agentAccessor.findById(supervisorId);
  if (!supervisor?.currentTaskId) {
    throw new Error(`Supervisor ${supervisorId} not found or has no task`);
  }

  const tasks = await taskAccessor.findByParentId(supervisor.currentTaskId);
  const activeTasks = tasks.filter((t) => t.state === TaskState.IN_PROGRESS);

  const healthyWorkers: string[] = [];
  const unhealthyWorkers: UnhealthyWorkerInfo[] = [];

  for (const task of activeTasks) {
    if (!task.assignedAgentId) {
      continue;
    }

    const worker = await agentAccessor.findById(task.assignedAgentId);
    if (!worker) {
      continue;
    }

    const healthCheck = getWorkerHealthStatus(worker, task.id);
    if (healthCheck) {
      unhealthyWorkers.push(healthCheck);
    } else {
      healthyWorkers.push(worker.id);
    }
  }

  return { healthyWorkers, unhealthyWorkers };
}

/**
 * Check a single worker's health and return UnhealthyWorkerInfo if unhealthy, null if healthy.
 */
function getWorkerHealthStatus(worker: Agent, taskId: string): UnhealthyWorkerInfo | null {
  const heartbeatTime = worker.lastHeartbeat ?? worker.createdAt;
  const minutesSinceHeartbeat = Math.floor((Date.now() - heartbeatTime.getTime()) / (60 * 1000));
  const cliStatus = worker.cliProcessStatus;

  const base = { workerId: worker.id, taskId, minutesSinceHeartbeat, cliProcessStatus: cliStatus };

  // Check 1: CLI process status indicates crash or unexpected exit
  if (
    cliStatus === CliProcessStatus.CRASHED ||
    cliStatus === CliProcessStatus.KILLED ||
    cliStatus === CliProcessStatus.EXITED
  ) {
    return { ...base, reason: 'process_crashed' };
  }

  // Check 2: ExecutionState is CRASHED in database
  if (worker.executionState === ExecutionState.CRASHED) {
    return { ...base, reason: 'crashed_state' };
  }

  // Check 3: Process not running in memory (handles server restart)
  if (
    worker.executionState === ExecutionState.ACTIVE &&
    !agentProcessAdapter.isRunning(worker.id)
  ) {
    return { ...base, reason: 'process_not_running' };
  }

  // Check 4: Stale heartbeat (fallback check)
  if (minutesSinceHeartbeat >= WORKER_HEALTH_THRESHOLD_MINUTES) {
    return { ...base, reason: 'stale_heartbeat' };
  }

  return null;
}

/**
 * Recover a crashed worker
 *
 * @param workerId - The ID of the crashed worker
 * @param taskId - The ID of the task the worker was working on
 * @param supervisorId - The ID of the supervisor triggering recovery
 * @returns Recovery result
 */
export async function recoverWorker(
  workerId: string,
  taskId: string,
  supervisorId: string
): Promise<{
  success: boolean;
  newWorkerId?: string;
  attemptNumber?: number;
  permanentFailure?: boolean;
  message: string;
}> {
  // Get task
  const task = await taskAccessor.findById(taskId);
  if (!task) {
    return {
      success: false,
      message: `Task ${taskId} not found`,
    };
  }

  // Get supervisor - if it doesn't exist, we can't use it as fromAgentId
  const supervisor = await agentAccessor.findById(supervisorId);
  const topLevelTaskId = supervisor?.currentTaskId;
  // Only use supervisorId for mail if the supervisor exists in the database
  const validSupervisorId = supervisor ? supervisorId : undefined;

  // Get current attempt count from task and increment
  const attempts = (task.attempts || 0) + 1;

  // Check if max attempts reached
  if (attempts >= MAX_WORKER_ATTEMPTS) {
    // Permanent failure
    await taskAccessor.update(taskId, {
      state: TaskState.FAILED,
      attempts,
      failureReason: `Worker crashed ${MAX_WORKER_ATTEMPTS} times. Last worker ID: ${workerId}`,
    });

    // Mark worker as crashed
    await agentAccessor.update(workerId, {
      executionState: ExecutionState.CRASHED,
    });

    // Send mail to supervisor
    await mailAccessor.create({
      fromAgentId: undefined, // System message
      toAgentId: supervisorId,
      subject: `Task Failed - Max Attempts Reached`,
      body: `Task "${task.title}" (${taskId}) has failed permanently after ${MAX_WORKER_ATTEMPTS} worker crash attempts.\n\nThe task has been marked as FAILED. You may need to manually investigate or mark it for completion.`,
    });

    // Send mail to human
    await mailAccessor.create({
      fromAgentId: validSupervisorId,
      isForHuman: true,
      subject: `Task Permanently Failed: ${task.title}`,
      body: `The task "${task.title}" has failed after ${MAX_WORKER_ATTEMPTS} worker recovery attempts.\n\nTask ID: ${taskId}\nTop-level Task ID: ${topLevelTaskId || 'unknown'}\n\nManual intervention may be required.`,
    });

    // Log decision
    await decisionLogAccessor.createManual(
      supervisorId,
      `Task permanently failed after ${MAX_WORKER_ATTEMPTS} attempts`,
      `Worker ${workerId} crashed and recovery limit reached`,
      JSON.stringify({ taskId, workerId, attempts })
    );

    return {
      success: false,
      attemptNumber: attempts,
      permanentFailure: true,
      message: `Task failed permanently after ${MAX_WORKER_ATTEMPTS} recovery attempts`,
    };
  }

  // Get the old worker's session information before killing it (for resume capability)
  const oldWorker = await agentAccessor.findById(workerId);

  // Try to get the Claude session ID from the adapter first (more reliable if process was running)
  // Fall back to the sessionId stored in the database
  let resumeSessionId: string | undefined;

  // First try to get the live Claude session ID from the adapter
  const liveClaudeSessionId = agentProcessAdapter.getClaudeSessionId(workerId);
  if (liveClaudeSessionId) {
    resumeSessionId = liveClaudeSessionId;
    console.log(
      `Worker ${workerId} has live Claude session ID ${resumeSessionId}, will attempt resume`
    );
  } else if (oldWorker?.sessionId) {
    // Fall back to stored session ID
    resumeSessionId = oldWorker.sessionId;
    console.log(`Worker ${workerId} has stored session ID ${resumeSessionId}, will attempt resume`);
  }

  // Kill the old worker
  try {
    await killWorkerAndCleanup(workerId);
  } catch (error) {
    console.error(`Failed to kill worker ${workerId}:`, error);
    // Continue anyway - the process might already be dead
  }

  // Mark old worker as crashed and update process status
  await agentAccessor.update(workerId, {
    executionState: ExecutionState.CRASHED,
    cliProcessStatus: CliProcessStatus.CRASHED,
  });

  // Update task with attempt count and set back to IN_PROGRESS
  await taskAccessor.update(taskId, {
    state: TaskState.IN_PROGRESS,
    assignedAgentId: null, // Clear assignment, new worker will be assigned
    attempts,
    failureReason: null, // Clear failure reason since we're retrying
  });

  // Create new worker with resume capability if session ID exists
  // This preserves conversation history and context from the crashed session
  let newWorkerId: string;
  try {
    newWorkerId = await startWorker(taskId, {
      resumeSessionId,
    });
  } catch (error) {
    console.error(`Failed to create new worker for task ${taskId}:`, error);
    return {
      success: false,
      attemptNumber: attempts,
      message: `Failed to create new worker: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Log decision
  await decisionLogAccessor.createManual(
    supervisorId,
    `Worker crashed and recreated (attempt ${attempts}/${MAX_WORKER_ATTEMPTS})`,
    `Worker ${workerId} became unresponsive, created new worker ${newWorkerId}${resumeSessionId ? ' with session resume' : ''}`,
    JSON.stringify({
      taskId,
      oldWorkerId: workerId,
      newWorkerId,
      attempts,
      resumeSessionId: resumeSessionId ?? null,
    })
  );

  console.log(
    `Worker recovered: ${workerId} -> ${newWorkerId} (attempt ${attempts}/${MAX_WORKER_ATTEMPTS})${resumeSessionId ? ' with session resume' : ''}`
  );

  return {
    success: true,
    newWorkerId,
    attemptNumber: attempts,
    message: `Worker recreated (attempt ${attempts}/${MAX_WORKER_ATTEMPTS})${resumeSessionId ? ' with session resume' : ''}`,
  };
}
