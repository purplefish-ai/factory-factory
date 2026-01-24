import { AgentType } from '@prisma-gen/client';
import { agentAccessor } from '../../resource_accessors/index.js';
import {
  type CreateSupervisorOptions,
  createSupervisor,
  isSupervisorRunning,
  killSupervisor,
  runSupervisor,
  stopSupervisor,
} from './supervisor.agent.js';

// Re-export runSupervisor so it can be used to start an existing supervisor
export { runSupervisor };

export interface StartSupervisorOptions extends CreateSupervisorOptions {}

/**
 * Start a supervisor for a top-level task
 * Creates the supervisor agent, sets up environment, and starts execution
 *
 * @param taskId - The top-level task to start a supervisor for
 * @param options - Optional settings including resumeSessionId for crash recovery
 */
export async function startSupervisorForTask(
  taskId: string,
  options?: StartSupervisorOptions
): Promise<string> {
  // Create supervisor (with optional resume session ID for crash recovery)
  const agentId = await createSupervisor(taskId, options);

  console.log(`Starting supervisor ${agentId} for task ${taskId}...`);

  // Run supervisor in background (don't await)
  runSupervisor(agentId).catch((error) => {
    console.error(`Supervisor ${agentId} failed:`, error);
  });

  return agentId;
}

/**
 * Stop a supervisor gracefully
 */
export async function stopSupervisorGracefully(agentId: string): Promise<void> {
  if (!isSupervisorRunning(agentId)) {
    throw new Error(`Supervisor ${agentId} is not running`);
  }

  console.log(`Stopping supervisor ${agentId}...`);
  await stopSupervisor(agentId);
}

/**
 * Kill a supervisor and clean up all resources
 */
export async function killSupervisorAndCleanup(agentId: string): Promise<void> {
  console.log(`Killing supervisor ${agentId}...`);
  await killSupervisor(agentId);
}

/**
 * Recreate a crashed or failed supervisor
 */
export async function recreateSupervisor(taskId: string): Promise<string> {
  console.log(`Recreating supervisor for task ${taskId}...`);

  // Find existing supervisor agent for this task
  const existingSupervisor = await agentAccessor.findByTaskId(taskId);

  if (existingSupervisor) {
    // Clean up old supervisor
    try {
      await killSupervisorAndCleanup(existingSupervisor.id);
    } catch (error) {
      console.error(`Failed to clean up old supervisor ${existingSupervisor.id}:`, error);
    }

    // Remove the task association so we can create a new supervisor
    await agentAccessor.update(existingSupervisor.id, {
      currentTaskId: null,
    });
  }

  // Create new supervisor
  return startSupervisorForTask(taskId);
}

/**
 * Get supervisor status
 */
export async function getSupervisorStatus(agentId: string): Promise<{
  agentId: string;
  isRunning: boolean;
  executionState: string;
  taskId: string | null;
  tmuxSession: string | null;
}> {
  const agent = await agentAccessor.findById(agentId);
  if (!agent) {
    throw new Error(`Agent with ID '${agentId}' not found`);
  }

  return {
    agentId: agent.id,
    isRunning: isSupervisorRunning(agentId),
    executionState: agent.executionState,
    taskId: agent.currentTaskId,
    tmuxSession: agent.tmuxSessionName,
  };
}

/**
 * Get supervisor for a top-level task
 */
export async function getSupervisorForTask(taskId: string): Promise<string | null> {
  const supervisor = await agentAccessor.findByTaskId(taskId);
  return supervisor?.id || null;
}

/**
 * List all supervisors
 */
export async function listAllSupervisors(): Promise<
  Array<{
    agentId: string;
    taskId: string | null;
    executionState: string;
    isRunning: boolean;
  }>
> {
  const supervisors = await agentAccessor.findByType(AgentType.SUPERVISOR);

  return supervisors.map((s) => ({
    agentId: s.id,
    taskId: s.currentTaskId,
    executionState: s.executionState,
    isRunning: isSupervisorRunning(s.id),
  }));
}
