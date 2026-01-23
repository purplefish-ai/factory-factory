import { AgentType } from '@prisma-gen/client';
import { agentAccessor } from '../../resource_accessors/index.js';
import {
  createSupervisor,
  isSupervisorRunning,
  killSupervisor,
  runSupervisor,
  stopSupervisor,
} from './supervisor.agent.js';

// Re-export runSupervisor so it can be used to start an existing supervisor
export { runSupervisor };

/**
 * Start a supervisor for an epic
 * Creates the supervisor agent, sets up environment, and starts execution
 */
export async function startSupervisorForEpic(epicId: string): Promise<string> {
  // Create supervisor
  const agentId = await createSupervisor(epicId);

  console.log(`Starting supervisor ${agentId} for epic ${epicId}...`);

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
export async function recreateSupervisor(epicId: string): Promise<string> {
  console.log(`Recreating supervisor for epic ${epicId}...`);

  // Find existing supervisor agent for this epic
  const existingSupervisor = await agentAccessor.findByEpicId(epicId);

  if (existingSupervisor) {
    // Clean up old supervisor
    try {
      await killSupervisorAndCleanup(existingSupervisor.id);
    } catch (error) {
      console.error(`Failed to clean up old supervisor ${existingSupervisor.id}:`, error);
    }

    // Remove the epic association so we can create a new supervisor
    await agentAccessor.update(existingSupervisor.id, {
      currentEpicId: null,
    });
  }

  // Create new supervisor
  return startSupervisorForEpic(epicId);
}

/**
 * Get supervisor status
 */
export async function getSupervisorStatus(agentId: string): Promise<{
  agentId: string;
  isRunning: boolean;
  agentState: string;
  epicId: string | null;
  tmuxSession: string | null;
}> {
  const agent = await agentAccessor.findById(agentId);
  if (!agent) {
    throw new Error(`Agent with ID '${agentId}' not found`);
  }

  return {
    agentId: agent.id,
    isRunning: isSupervisorRunning(agentId),
    agentState: agent.state,
    epicId: agent.currentEpicId,
    tmuxSession: agent.tmuxSessionName,
  };
}

/**
 * Get supervisor for epic
 */
export async function getSupervisorForEpic(epicId: string): Promise<string | null> {
  const supervisor = await agentAccessor.findByEpicId(epicId);
  return supervisor?.id || null;
}

/**
 * List all supervisors
 */
export async function listAllSupervisors(): Promise<
  Array<{
    agentId: string;
    epicId: string | null;
    state: string;
    isRunning: boolean;
  }>
> {
  const supervisors = await agentAccessor.findByType(AgentType.SUPERVISOR);

  return supervisors.map((s) => ({
    agentId: s.id,
    epicId: s.currentEpicId,
    state: s.state,
    isRunning: isSupervisorRunning(s.id),
  }));
}
