import {
  createWorker,
  runWorker,
  stopWorker,
  killWorker,
  isWorkerRunning,
} from './worker.agent.js';
import { taskAccessor, agentAccessor } from '../../resource_accessors/index.js';

/**
 * Start a worker for a task
 * Creates the worker agent, sets up environment, and starts execution
 */
export async function startWorker(taskId: string): Promise<string> {
  // Create worker
  const agentId = await createWorker(taskId);

  console.log(`Starting worker ${agentId} for task ${taskId}...`);

  // Run worker in background (don't await)
  runWorker(agentId).catch((error) => {
    console.error(`Worker ${agentId} failed:`, error);
  });

  return agentId;
}

/**
 * Stop a worker gracefully
 */
export async function stopWorkerGracefully(agentId: string): Promise<void> {
  if (!isWorkerRunning(agentId)) {
    throw new Error(`Worker ${agentId} is not running`);
  }

  console.log(`Stopping worker ${agentId}...`);
  await stopWorker(agentId);
}

/**
 * Kill a worker and clean up all resources
 */
export async function killWorkerAndCleanup(agentId: string): Promise<void> {
  console.log(`Killing worker ${agentId}...`);
  await killWorker(agentId);
}

/**
 * Recreate a crashed or failed worker
 */
export async function recreateWorker(taskId: string): Promise<string> {
  console.log(`Recreating worker for task ${taskId}...`);

  // Find existing worker agent for this task
  const task = await taskAccessor.findById(taskId);
  if (!task) {
    throw new Error(`Task with ID '${taskId}' not found`);
  }

  if (task.assignedAgentId) {
    // Clean up old worker
    try {
      await killWorkerAndCleanup(task.assignedAgentId);
    } catch (error) {
      console.error(`Failed to clean up old worker ${task.assignedAgentId}:`, error);
    }
  }

  // Create new worker
  return startWorker(taskId);
}

/**
 * Get worker status
 */
export async function getWorkerStatus(agentId: string): Promise<{
  agentId: string;
  isRunning: boolean;
  agentState: string;
  taskId: string | null;
  tmuxSession: string | null;
}> {
  const agent = await agentAccessor.findById(agentId);
  if (!agent) {
    throw new Error(`Agent with ID '${agentId}' not found`);
  }

  return {
    agentId: agent.id,
    isRunning: isWorkerRunning(agentId),
    agentState: agent.state,
    taskId: agent.currentTaskId,
    tmuxSession: agent.tmuxSessionName,
  };
}

/**
 * List all workers for a task
 */
export async function listWorkersForTask(taskId: string): Promise<string[]> {
  const task = await taskAccessor.findById(taskId);
  if (!task) {
    throw new Error(`Task with ID '${taskId}' not found`);
  }

  if (!task.assignedAgentId) {
    return [];
  }

  return [task.assignedAgentId];
}
