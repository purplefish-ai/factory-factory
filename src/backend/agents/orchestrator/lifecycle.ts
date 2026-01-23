/**
 * Orchestrator Lifecycle Management
 *
 * Provides high-level lifecycle operations for the orchestrator:
 * - Start the orchestrator (create if needed)
 * - Stop the orchestrator gracefully
 * - Kill the orchestrator and cleanup
 * - Get orchestrator status
 */

import { AgentType, AgentState } from '@prisma/client';
import {
  createOrchestrator,
  runOrchestrator,
  stopOrchestrator,
  killOrchestrator,
  getActiveOrchestrator,
  isOrchestratorRunning,
} from './orchestrator.agent.js';
import { agentAccessor } from '../../resource_accessors/index.js';

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
  // Check for existing orchestrators
  const existingOrchestrators = await agentAccessor.findByType(AgentType.ORCHESTRATOR);

  // Find active (non-failed) orchestrators
  const activeOrchestrators = existingOrchestrators.filter(
    (o) => o.state !== AgentState.FAILED
  );

  // If there's an active orchestrator, check if it's running
  if (activeOrchestrators.length > 0) {
    const orchestrator = activeOrchestrators[0];

    // Check if it's actually running in our process
    if (isOrchestratorRunning(orchestrator.id)) {
      console.log(`Orchestrator ${orchestrator.id} is already running`);
      return orchestrator.id;
    }

    // Check health - if unhealthy, kill and recreate
    const now = Date.now();
    const minutesSinceHeartbeat = Math.floor(
      (now - orchestrator.lastActiveAt.getTime()) / (60 * 1000)
    );

    if (minutesSinceHeartbeat >= 2) {
      console.log(
        `Orchestrator ${orchestrator.id} is unhealthy (${minutesSinceHeartbeat} min since heartbeat). Killing and recreating...`
      );
      try {
        await killOrchestrator(orchestrator.id);
      } catch (error) {
        console.error(`Failed to kill unhealthy orchestrator ${orchestrator.id}:`, error);
      }

      // Mark as failed
      await agentAccessor.update(orchestrator.id, {
        state: AgentState.FAILED,
      });
    } else {
      // Orchestrator exists but isn't running in our process - try to run it
      console.log(`Starting existing orchestrator ${orchestrator.id}...`);
      try {
        await runOrchestrator(orchestrator.id);
        return orchestrator.id;
      } catch (error) {
        console.error(`Failed to run existing orchestrator ${orchestrator.id}:`, error);
        // Kill it and create a new one
        try {
          await killOrchestrator(orchestrator.id);
          await agentAccessor.update(orchestrator.id, {
            state: AgentState.FAILED,
          });
        } catch (killError) {
          console.error(`Failed to kill orchestrator ${orchestrator.id}:`, killError);
        }
      }
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
  if (active && active.isRunning) {
    return active.agentId;
  }

  // Then check database
  const orchestrators = await agentAccessor.findByType(AgentType.ORCHESTRATOR);
  const activeOrchestrators = orchestrators.filter(
    (o) => o.state !== AgentState.FAILED
  );

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
  const minutesSinceHeartbeat = Math.floor(
    (now - agent.lastActiveAt.getTime()) / (60 * 1000)
  );

  return {
    agentId: agent.id,
    isRunning: isOrchestratorRunning(agentId),
    agentState: agent.state,
    tmuxSession: agent.tmuxSessionName,
    lastActiveAt: agent.lastActiveAt,
    minutesSinceHeartbeat,
  };
}

/**
 * Ensure an orchestrator is running
 * This is meant to be called during system startup
 */
export async function ensureOrchestratorRunning(): Promise<string> {
  const existingId = await getOrchestrator();
  if (existingId && isOrchestratorRunning(existingId)) {
    return existingId;
  }

  return startOrchestrator();
}
