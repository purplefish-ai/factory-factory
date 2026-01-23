/**
 * Supervisor Health Monitoring
 *
 * This module handles worker crash detection and recovery from the supervisor's perspective.
 * The supervisor periodically checks worker health and triggers recovery when needed.
 */

import { AgentState, TaskState } from '@prisma/client';
import {
  agentAccessor,
  taskAccessor,
  mailAccessor,
  decisionLogAccessor,
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
 * Check health of all workers for a supervisor's epic
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
  if (!supervisor || !supervisor.currentEpicId) {
    throw new Error(`Supervisor ${supervisorId} not found or has no epic`);
  }

  const epicId = supervisor.currentEpicId;

  // Get all tasks for this epic that are in progress
  const tasks = await taskAccessor.list({ epicId });
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

    const minutesSinceHeartbeat = Math.floor(
      (now - worker.lastActiveAt.getTime()) / (60 * 1000)
    );

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

  // Get epic for logging
  const supervisor = await agentAccessor.findById(supervisorId);
  const epicId = supervisor?.currentEpicId;

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
      fromAgentId: supervisorId,
      isForHuman: true,
      subject: `Task Permanently Failed: ${task.title}`,
      body: `The task "${task.title}" has failed after ${MAX_WORKER_ATTEMPTS} worker recovery attempts.\n\nTask ID: ${taskId}\nEpic ID: ${epicId || 'unknown'}\n\nManual intervention may be required.`,
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

  // Create new worker
  let newWorkerId: string;
  try {
    newWorkerId = await startWorker(taskId);
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

/**
 * Send health check mail to a worker
 * Used to proactively check if a worker is still active
 */
export async function sendWorkerHealthCheck(
  supervisorId: string,
  workerId: string,
  taskId: string
): Promise<void> {
  const task = await taskAccessor.findById(taskId);
  const taskTitle = task?.title || 'Unknown task';

  await mailAccessor.create({
    fromAgentId: supervisorId,
    toAgentId: workerId,
    subject: 'Health Check - Please confirm you are active',
    body: `This is a health check from your supervisor.\n\nPlease confirm you are still active by replying to this message with your current status.\n\nTask: ${taskTitle}\nTask ID: ${taskId}\n\nIf you don't respond within 7 minutes, you may be marked as unresponsive and recovered.`,
  });

  console.log(`Sent health check to worker ${workerId} for task ${taskId}`);
}

/**
 * Get health summary for all workers in an epic
 */
export async function getWorkerHealthSummary(epicId: string): Promise<{
  totalWorkers: number;
  healthyWorkers: number;
  unhealthyWorkers: number;
  workers: Array<{
    workerId: string;
    taskId: string;
    taskTitle: string;
    state: string;
    isHealthy: boolean;
    minutesSinceHeartbeat: number;
  }>;
}> {
  const tasks = await taskAccessor.list({ epicId });
  const now = Date.now();

  const workers: Array<{
    workerId: string;
    taskId: string;
    taskTitle: string;
    state: string;
    isHealthy: boolean;
    minutesSinceHeartbeat: number;
  }> = [];

  for (const task of tasks) {
    if (!task.assignedAgentId) {
      continue;
    }

    const worker = await agentAccessor.findById(task.assignedAgentId);
    if (!worker) {
      continue;
    }

    const minutesSinceHeartbeat = Math.floor(
      (now - worker.lastActiveAt.getTime()) / (60 * 1000)
    );

    const isHealthy =
      minutesSinceHeartbeat < WORKER_HEALTH_THRESHOLD_MINUTES &&
      worker.state !== AgentState.FAILED;

    workers.push({
      workerId: worker.id,
      taskId: task.id,
      taskTitle: task.title,
      state: worker.state,
      isHealthy,
      minutesSinceHeartbeat,
    });
  }

  return {
    totalWorkers: workers.length,
    healthyWorkers: workers.filter((w) => w.isHealthy).length,
    unhealthyWorkers: workers.filter((w) => !w.isHealthy).length,
    workers,
  };
}
