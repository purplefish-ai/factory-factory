/**
 * Orchestrator Lifecycle Management
 *
 * Provides high-level lifecycle operations for the orchestrator:
 * - Start the orchestrator (create if needed)
 * - Stop the orchestrator gracefully
 * - Kill the orchestrator and cleanup
 * - Get orchestrator status
 */

import { AgentState, AgentType } from '@prisma-gen/client';
import { agentAccessor } from '../../resource_accessors/index.js';
import {
  createOrchestrator,
  getActiveOrchestrator,
  isOrchestratorRunning,
  killOrchestrator,
  runOrchestrator,
  stopOrchestrator,
} from './orchestrator.agent.js';

/**
 * Kill an unhealthy orchestrator and mark it as failed
 */
async function killUnhealthyOrchestrator(orchestratorId: string): Promise<void> {
  try {
    await killOrchestrator(orchestratorId);
  } catch (error) {
    console.error(`Failed to kill unhealthy orchestrator ${orchestratorId}:`, error);
  }
  await agentAccessor.update(orchestratorId, { state: AgentState.FAILED });
}

/**
 * Try to run an existing orchestrator, kill and mark failed if unsuccessful
 */
async function tryRunExistingOrchestrator(orchestratorId: string): Promise<boolean> {
  console.log(`Starting existing orchestrator ${orchestratorId}...`);
  try {
    await runOrchestrator(orchestratorId);
    return true;
  } catch (error) {
    console.error(`Failed to run existing orchestrator ${orchestratorId}:`, error);
    try {
      await killOrchestrator(orchestratorId);
      await agentAccessor.update(orchestratorId, { state: AgentState.FAILED });
    } catch (killError) {
      console.error(`Failed to kill orchestrator ${orchestratorId}:`, killError);
    }
    return false;
  }
}

/**
 * Handle an existing active orchestrator - returns its ID if successfully started, null otherwise
 */
async function handleExistingOrchestrator(orchestrator: {
  id: string;
  lastActiveAt: Date;
}): Promise<string | null> {
  // Already running in our process
  if (isOrchestratorRunning(orchestrator.id)) {
    console.log(`Orchestrator ${orchestrator.id} is already running`);
    return orchestrator.id;
  }

  // Check health
  const minutesSinceHeartbeat = Math.floor(
    (Date.now() - orchestrator.lastActiveAt.getTime()) / (60 * 1000)
  );

  if (minutesSinceHeartbeat >= 2) {
    console.log(
      `Orchestrator ${orchestrator.id} is unhealthy (${minutesSinceHeartbeat} min since heartbeat). Killing and recreating...`
    );
    await killUnhealthyOrchestrator(orchestrator.id);
    return null;
  }

  // Try to run existing healthy orchestrator
  const started = await tryRunExistingOrchestrator(orchestrator.id);
  return started ? orchestrator.id : null;
}

/**
 * Start the orchestrator
 *
 * This function ensures there is exactly one orchestrator running.
 * If an orchestrator already exists:
 * - If it's healthy, return its ID
 * - If it's unhealthy, kill it and create a new one
 * If no orchestrator exists, create a new one
 */
export async function startOrchestrator(): Promise<string> {
  const existingOrchestrators = await agentAccessor.findByType(AgentType.ORCHESTRATOR);
  const activeOrchestrators = existingOrchestrators.filter((o) => o.state !== AgentState.FAILED);

  if (activeOrchestrators.length > 0) {
    const result = await handleExistingOrchestrator(activeOrchestrators[0]);
    if (result) {
      return result;
    }
  }

  // Create new orchestrator
  console.log('Creating new orchestrator...');
  const agentId = await createOrchestrator();

  // Run orchestrator in background (don't await)
  runOrchestrator(agentId).catch((error) => {
    console.error(`Orchestrator ${agentId} failed:`, error);
  });

  return agentId;
}

/**
 * Stop the orchestrator gracefully
 */
export async function stopOrchestratorGracefully(agentId: string): Promise<void> {
  if (!isOrchestratorRunning(agentId)) {
    throw new Error(`Orchestrator ${agentId} is not running`);
  }

  console.log(`Stopping orchestrator ${agentId} gracefully...`);
  await stopOrchestrator(agentId);
}

/**
 * Kill the orchestrator and clean up all resources
 */
export async function killOrchestratorAndCleanup(agentId: string): Promise<void> {
  console.log(`Killing orchestrator ${agentId}...`);
  await killOrchestrator(agentId);
}

/**
 * Get the current orchestrator instance (if any)
 */
export async function getOrchestrator(): Promise<string | null> {
  // First check in-memory
  const active = getActiveOrchestrator();
  if (active?.isRunning) {
    return active.agentId;
  }

  // Then check database
  const orchestrators = await agentAccessor.findByType(AgentType.ORCHESTRATOR);
  const activeOrchestrators = orchestrators.filter((o) => o.state !== AgentState.FAILED);

  if (activeOrchestrators.length > 0) {
    return activeOrchestrators[0].id;
  }

  return null;
}

/**
 * Get orchestrator status
 */
export async function getOrchestratorStatus(agentId: string): Promise<{
  agentId: string;
  isRunning: boolean;
  agentState: string;
  tmuxSession: string | null;
  lastActiveAt: Date;
  minutesSinceHeartbeat: number;
}> {
  const agent = await agentAccessor.findById(agentId);
  if (!agent) {
    throw new Error(`Agent with ID '${agentId}' not found`);
  }

  if (agent.type !== AgentType.ORCHESTRATOR) {
    throw new Error(`Agent ${agentId} is not an orchestrator`);
  }

  const now = Date.now();
  const minutesSinceHeartbeat = Math.floor((now - agent.lastActiveAt.getTime()) / (60 * 1000));

  return {
    agentId: agent.id,
    isRunning: isOrchestratorRunning(agentId),
    agentState: agent.state,
    tmuxSession: agent.tmuxSessionName,
    lastActiveAt: agent.lastActiveAt,
    minutesSinceHeartbeat,
  };
}
