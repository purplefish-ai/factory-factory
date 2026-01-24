/**
 * Supervisor Health Monitoring
 *
 * This module handles worker crash detection and recovery from the supervisor's perspective.
 * The supervisor periodically checks worker health and triggers recovery when needed.
 */

import { AgentState, TaskState } from '@prisma-gen/client';
import {
  agentAccessor,
  decisionLogAccessor,
  mailAccessor,
  taskAccessor,
} from '../../resource_accessors/index.js';
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
 * Check health of all workers for a supervisor's top-level task
 * Returns list of unhealthy workers
 */
export async function checkWorkerHealth(supervisorId: string): Promise<{
  healthyWorkers: string[];
  unhealthyWorkers: Array<{
    workerId: string;
    taskId: string;
    minutesSinceHeartbeat: number;
  }>;
}> {
  // Get supervisor
  const supervisor = await agentAccessor.findById(supervisorId);
  if (!supervisor?.currentTaskId) {
    throw new Error(`Supervisor ${supervisorId} not found or has no task`);
  }

  const topLevelTaskId = supervisor.currentTaskId;

  // Get all child tasks for this top-level task that are in progress
  const tasks = await taskAccessor.findByParentId(topLevelTaskId);
  const activeTasks = tasks.filter(
    (t) => t.state === TaskState.IN_PROGRESS || t.state === TaskState.ASSIGNED
  );

  const healthyWorkers: string[] = [];
  const unhealthyWorkers: Array<{
    workerId: string;
    taskId: string;
    minutesSinceHeartbeat: number;
  }> = [];

  const now = Date.now();

  for (const task of activeTasks) {
    if (!task.assignedAgentId) {
      continue;
    }

    const worker = await agentAccessor.findById(task.assignedAgentId);
    if (!worker) {
      continue;
    }

    const minutesSinceHeartbeat = Math.floor((now - worker.lastActiveAt.getTime()) / (60 * 1000));

    if (
      minutesSinceHeartbeat >= WORKER_HEALTH_THRESHOLD_MINUTES ||
      worker.state === AgentState.FAILED
    ) {
      unhealthyWorkers.push({
        workerId: worker.id,
        taskId: task.id,
        minutesSinceHeartbeat,
      });
    } else {
      healthyWorkers.push(worker.id);
    }
  }

  return { healthyWorkers, unhealthyWorkers };
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

    // Mark worker as failed
    await agentAccessor.update(workerId, {
      state: AgentState.FAILED,
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

  // Get the old session ID before killing the worker (for resume capability)
  const oldWorker = await agentAccessor.findById(workerId);
  const oldSessionId = oldWorker?.sessionId;

  if (oldSessionId) {
    console.log(`Worker ${workerId} has session ID ${oldSessionId}, will attempt resume`);
  }

  // Kill the old worker
  try {
    await killWorkerAndCleanup(workerId);
  } catch (error) {
    console.error(`Failed to kill worker ${workerId}:`, error);
    // Continue anyway
  }

  // Mark old worker as failed
  await agentAccessor.update(workerId, {
    state: AgentState.FAILED,
  });

  // Update task with attempt count and set back to IN_PROGRESS
  await taskAccessor.update(taskId, {
    state: TaskState.IN_PROGRESS,
    assignedAgentId: null, // Clear assignment, new worker will be assigned
    attempts,
    failureReason: null, // Clear failure reason since we're retrying
  });

  // Create new worker with resume capability if old session ID exists
  // This preserves conversation history and context from the crashed session
  let newWorkerId: string;
  try {
    newWorkerId = await startWorker(taskId, {
      resumeSessionId: oldSessionId ?? undefined,
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
    `Worker ${workerId} became unresponsive, created new worker ${newWorkerId}`,
    JSON.stringify({ taskId, oldWorkerId: workerId, newWorkerId, attempts })
  );

  console.log(
    `Worker recovered: ${workerId} -> ${newWorkerId} (attempt ${attempts}/${MAX_WORKER_ATTEMPTS})`
  );

  return {
    success: true,
    newWorkerId,
    attemptNumber: attempts,
    message: `Worker recreated (attempt ${attempts}/${MAX_WORKER_ATTEMPTS})`,
  };
}
