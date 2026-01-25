/**
 * Orchestrator Agent
 *
 * The orchestrator is the top-level agent that manages all supervisors.
 * It monitors supervisor health, creates supervisors for new epics,
 * and triggers cascading recovery when supervisors crash.
 *
 * There should only be ONE orchestrator instance running at a time.
 */

import { AgentType, DesiredExecutionState, ExecutionState } from '@prisma-gen/client';
import { agentAccessor, decisionLogAccessor } from '../../resource_accessors/index.js';
import { type AgentProcessEvents, agentProcessAdapter } from '../process-adapter.js';
import { buildOrchestratorPrompt } from '../prompts/builders/orchestrator.builder.js';
import { promptFileManager } from '../prompts/file-manager.js';
import { startSupervisorForTask } from '../supervisor/lifecycle.js';
import {
  checkSupervisorHealth,
  getPendingTopLevelTasksNeedingSupervisors,
  recoverSupervisor,
} from './health.js';

/**
 * Orchestrator agent context - tracks the running orchestrator
 */
interface OrchestratorContext {
  agentId: string;
  isRunning: boolean;
  healthCheckInterval?: NodeJS.Timeout;
  epicCheckInterval?: NodeJS.Timeout;
  eventCleanup?: () => void;
}

// In-memory store for the active orchestrator (singleton)
let activeOrchestrator: OrchestratorContext | null = null;

// Cache for orchestrator prompts (used between createOrchestrator and runOrchestrator)
const orchestratorPromptCache = new Map<
  string,
  {
    systemPrompt: string;
    workingDir: string;
    resumeSessionId?: string;
  }
>();

/**
 * Health check interval in milliseconds (7 minutes)
 */
const HEALTH_CHECK_INTERVAL_MS = 7 * 60 * 1000;

/**
 * Epic check interval in milliseconds (30 seconds)
 */
const EPIC_CHECK_INTERVAL_MS = 30 * 1000;

export interface CreateOrchestratorOptions {
  /** If provided, resume an existing Claude session instead of starting fresh */
  resumeSessionId?: string;
}

/**
 * Create a new orchestrator agent
 */
export async function createOrchestrator(options?: CreateOrchestratorOptions): Promise<string> {
  // Check if orchestrator already exists
  const existingOrchestrators = await agentAccessor.findByType(AgentType.ORCHESTRATOR);
  const activeOrchestrators = existingOrchestrators.filter(
    (o) => o.executionState !== ExecutionState.CRASHED
  );

  if (activeOrchestrators.length > 0) {
    throw new Error(
      `An orchestrator already exists (${activeOrchestrators[0].id}). Kill it first before creating a new one.`
    );
  }

  // Create agent record
  const agent = await agentAccessor.create({
    type: AgentType.ORCHESTRATOR,
    executionState: ExecutionState.IDLE,
    desiredExecutionState: DesiredExecutionState.IDLE,
  });

  // Build system prompt
  const backendUrl = `http://localhost:${process.env.BACKEND_PORT || 3001}`;
  const systemPrompt = buildOrchestratorPrompt({
    agentId: agent.id,
    backendUrl,
  });

  // Get the repo root directory
  const repoRoot = process.cwd();

  // Update agent with session info (if resuming)
  await agentAccessor.update(agent.id, {
    worktreePath: repoRoot,
    ...(options?.resumeSessionId && { sessionId: options.resumeSessionId }),
  });

  // Store prompt for use when starting the agent
  orchestratorPromptCache.set(agent.id, {
    systemPrompt,
    workingDir: repoRoot,
    resumeSessionId: options?.resumeSessionId,
  });

  console.log(`Created orchestrator ${agent.id}`);

  return agent.id;
}

/**
 * Run the orchestrator agent - starts monitoring and health checks
 */
export async function runOrchestrator(agentId: string): Promise<void> {
  // Get agent
  const agent = await agentAccessor.findById(agentId);
  if (!agent) {
    throw new Error(`Agent with ID '${agentId}' not found`);
  }

  if (agent.type !== AgentType.ORCHESTRATOR) {
    throw new Error(`Agent '${agentId}' is not an ORCHESTRATOR`);
  }

  // Check if already running
  if (activeOrchestrator?.isRunning) {
    throw new Error(`Orchestrator ${activeOrchestrator.agentId} is already running`);
  }

  // Get cached prompt info
  const promptInfo = orchestratorPromptCache.get(agentId);
  if (!promptInfo) {
    throw new Error(`No prompt info found for agent ${agentId}. Was createOrchestrator called?`);
  }

  // Create orchestrator context
  const orchestratorContext: OrchestratorContext = {
    agentId,
    isRunning: true,
  };
  activeOrchestrator = orchestratorContext;

  // Update agent state
  await agentAccessor.update(agentId, {
    executionState: ExecutionState.ACTIVE,
  });

  console.log(`Starting orchestrator ${agentId}`);

  // Set up event handlers for the adapter
  const handleMessage = (event: AgentProcessEvents['message']) => {
    if (event.agentId !== agentId) {
      return;
    }

    const msg = event.message;

    // Log messages for debugging based on type
    switch (msg.type) {
      case 'assistant':
        console.log(`Orchestrator ${agentId}: Assistant message received`);
        break;
      case 'tool_use':
        console.log(`Orchestrator ${agentId}: Tool use - ${'tool' in msg ? msg.tool : 'unknown'}`);
        break;
      case 'tool_result':
        console.log(
          `Orchestrator ${agentId}: Tool result - ${'is_error' in msg && msg.is_error ? 'error' : 'success'}`
        );
        break;
    }
  };

  const handleResult = async (event: AgentProcessEvents['result']) => {
    if (event.agentId !== agentId) {
      return;
    }

    console.log(`Orchestrator ${agentId}: Session completed`);
    console.log(`  Claude Session ID: ${event.claudeSessionId}`);
    console.log(`  Turns: ${event.numTurns}`);
    console.log(`  Duration: ${event.durationMs}ms`);
    console.log(`  Cost: $${event.totalCostUsd?.toFixed(4) || 'N/A'}`);

    // Store Claude session ID for potential resume
    await agentAccessor.update(agentId, {
      sessionId: event.claudeSessionId,
    });

    // Handle completion
    await handleOrchestratorCompletion(agentId, 'Claude session completed');
  };

  const handleError = (event: AgentProcessEvents['error']) => {
    if (event.agentId !== agentId) {
      return;
    }

    console.error(`Orchestrator ${agentId}: Error - ${event.error.message}`);

    // Don't stop the orchestrator on errors - adapter handles recovery
  };

  const handleExit = async (event: AgentProcessEvents['exit']) => {
    if (event.agentId !== agentId) {
      return;
    }

    console.log(`Orchestrator ${agentId}: Process exited with code ${event.code}`);

    if (event.sessionId) {
      // Store session ID for potential resume
      await agentAccessor.update(agentId, {
        sessionId: event.sessionId,
      });
    }

    // Handle completion based on exit code
    const reason =
      event.code === 0 ? 'Process exited normally' : `Process exited with code ${event.code}`;
    await handleOrchestratorCompletion(agentId, reason);
  };

  // Register event handlers
  agentProcessAdapter.on('message', handleMessage);
  agentProcessAdapter.on('result', handleResult);
  agentProcessAdapter.on('error', handleError);
  agentProcessAdapter.on('exit', handleExit);

  // Store cleanup function
  orchestratorContext.eventCleanup = () => {
    agentProcessAdapter.off('message', handleMessage);
    agentProcessAdapter.off('result', handleResult);
    agentProcessAdapter.off('error', handleError);
    agentProcessAdapter.off('exit', handleExit);
  };

  // Start health check loop (check supervisor health)
  orchestratorContext.healthCheckInterval = setInterval(async () => {
    await performHealthCheck(agentId);
  }, HEALTH_CHECK_INTERVAL_MS);

  // Start epic check loop (check for pending epics)
  orchestratorContext.epicCheckInterval = setInterval(async () => {
    await checkForPendingTopLevelTasks(agentId);
  }, EPIC_CHECK_INTERVAL_MS);

  // Start the Claude process via the adapter
  try {
    const model = process.env.ORCHESTRATOR_MODEL || 'claude-sonnet-4-5-20250929';
    const initialPrompt =
      'Begin monitoring supervisors and managing epics. Check for pending epics and supervisor health.';

    await agentProcessAdapter.startAgent({
      agentId,
      agentType: 'orchestrator',
      workingDir: promptInfo.workingDir,
      systemPrompt: promptInfo.systemPrompt,
      initialPrompt,
      model,
      resumeSessionId: promptInfo.resumeSessionId,
    });

    console.log(`Orchestrator ${agentId} is now running`);

    // Clean up prompt cache after starting
    orchestratorPromptCache.delete(agentId);
  } catch (error) {
    // Clean up on startup failure
    cleanupOrchestratorContext(agentId);
    throw error;
  }
}

/**
 * Clean up orchestrator context (intervals and event handlers)
 */
function cleanupOrchestratorContext(agentId: string): void {
  if (!activeOrchestrator || activeOrchestrator.agentId !== agentId) {
    return;
  }

  // Clear health check interval
  if (activeOrchestrator.healthCheckInterval) {
    clearInterval(activeOrchestrator.healthCheckInterval);
  }

  // Clear epic check interval
  if (activeOrchestrator.epicCheckInterval) {
    clearInterval(activeOrchestrator.epicCheckInterval);
  }

  // Clean up event handlers
  if (activeOrchestrator.eventCleanup) {
    activeOrchestrator.eventCleanup();
  }

  activeOrchestrator.isRunning = false;
}

/**
 * Handle orchestrator completion (success or failure)
 */
async function handleOrchestratorCompletion(agentId: string, reason: string): Promise<void> {
  if (!activeOrchestrator || activeOrchestrator.agentId !== agentId) {
    return;
  }

  console.log(`Orchestrator ${agentId} completed: ${reason}`);

  // Clean up context
  cleanupOrchestratorContext(agentId);

  // Update agent state
  await agentAccessor.update(agentId, {
    executionState: ExecutionState.IDLE,
  });
}

/**
 * Perform health check on all supervisors
 * Triggers recovery for any unhealthy supervisors
 */
async function performHealthCheck(agentId: string): Promise<void> {
  if (!activeOrchestrator?.isRunning) {
    return;
  }

  try {
    console.log(`Orchestrator ${agentId}: Performing health check...`);

    const { healthySupervisors, unhealthySupervisors } = await checkSupervisorHealth(agentId);

    console.log(
      `Orchestrator ${agentId}: Health check complete. Healthy: ${healthySupervisors.length}, Unhealthy: ${unhealthySupervisors.length}`
    );

    // Trigger recovery for unhealthy supervisors
    for (const unhealthy of unhealthySupervisors) {
      console.log(
        `Orchestrator ${agentId}: Supervisor ${unhealthy.supervisorId} is unhealthy (${unhealthy.minutesSinceHeartbeat} minutes since heartbeat). Triggering recovery...`
      );

      try {
        const result = await recoverSupervisor(unhealthy.supervisorId, unhealthy.taskId, agentId);

        console.log(`Orchestrator ${agentId}: Recovery result - ${result.message}`);

        // Notify Claude about the recovery
        agentProcessAdapter.sendToAgent(
          agentId,
          `[AUTOMATIC HEALTH CHECK] Recovered unhealthy supervisor:\n` +
            `- Task: ${unhealthy.taskTitle}\n` +
            `- Old Supervisor: ${unhealthy.supervisorId}\n` +
            `- New Supervisor: ${result.newSupervisorId || 'FAILED'}\n` +
            `- Workers killed: ${result.workersKilled}\n` +
            `- Tasks reset: ${result.tasksReset}`
        );
      } catch (error) {
        console.error(
          `Orchestrator ${agentId}: Failed to recover supervisor ${unhealthy.supervisorId}:`,
          error
        );
      }
    }

    // Log health check
    await decisionLogAccessor.createManual(
      agentId,
      `Health check performed`,
      `Checked ${healthySupervisors.length + unhealthySupervisors.length} supervisors. ${unhealthySupervisors.length} unhealthy and recovered.`,
      JSON.stringify({
        healthy: healthySupervisors,
        unhealthy: unhealthySupervisors.map((u) => u.supervisorId),
      })
    );
  } catch (error) {
    console.error(`Orchestrator ${agentId}: Health check error:`, error);
  }
}

/**
 * Check for pending top-level tasks that need supervisors
 */
async function checkForPendingTopLevelTasks(agentId: string): Promise<void> {
  if (!activeOrchestrator?.isRunning) {
    return;
  }

  try {
    const pendingTasks = await getPendingTopLevelTasksNeedingSupervisors();

    if (pendingTasks.length > 0) {
      console.log(
        `Orchestrator ${agentId}: Found ${pendingTasks.length} pending top-level task(s) needing supervisors`
      );

      // Create supervisors for pending tasks
      for (const task of pendingTasks) {
        console.log(
          `Orchestrator ${agentId}: Creating supervisor for task "${task.title}" (${task.taskId})`
        );

        try {
          const supervisorId = await startSupervisorForTask(task.taskId);

          console.log(
            `Orchestrator ${agentId}: Created supervisor ${supervisorId} for task ${task.taskId}`
          );

          // Notify Claude about the new supervisor
          agentProcessAdapter.sendToAgent(
            agentId,
            `[AUTOMATIC TASK CHECK] Created supervisor for new task:\n` +
              `- Task: ${task.title}\n` +
              `- Task ID: ${task.taskId}\n` +
              `- Supervisor ID: ${supervisorId}`
          );

          // Log decision
          await decisionLogAccessor.createManual(
            agentId,
            `Created supervisor for pending task`,
            `Task "${task.title}" was in PLANNING state without a supervisor`,
            JSON.stringify({ taskId: task.taskId, supervisorId })
          );
        } catch (error) {
          console.error(
            `Orchestrator ${agentId}: Failed to create supervisor for task ${task.taskId}:`,
            error
          );
        }
      }
    }
  } catch (error) {
    console.error(`Orchestrator ${agentId}: Task check error:`, error);
  }
}

/**
 * Stop the orchestrator gracefully
 */
export async function stopOrchestrator(agentId: string): Promise<void> {
  if (!activeOrchestrator || activeOrchestrator.agentId !== agentId) {
    throw new Error(`Orchestrator ${agentId} is not running`);
  }

  console.log(`Stopping orchestrator ${agentId}`);

  // Clean up context
  cleanupOrchestratorContext(agentId);

  // Stop the Claude process gracefully
  await agentProcessAdapter.stopAgent(agentId);

  // Update agent state
  await agentAccessor.update(agentId, {
    executionState: ExecutionState.IDLE,
  });

  console.log(`Orchestrator ${agentId} stopped`);
}

/**
 * Kill the orchestrator and clean up resources
 */
export async function killOrchestrator(agentId: string): Promise<void> {
  console.log(`Killing orchestrator ${agentId}`);

  // Stop orchestrator if running
  try {
    await stopOrchestrator(agentId);
  } catch {
    // Orchestrator may not be running
  }

  // Get agent
  const agent = await agentAccessor.findById(agentId);
  if (!agent) {
    throw new Error(`Agent with ID '${agentId}' not found`);
  }

  // Force kill the Claude process
  agentProcessAdapter.killAgent(agentId);

  // Clean up system prompt file
  promptFileManager.deletePromptFile(agentId);

  // Clear active orchestrator reference
  if (activeOrchestrator && activeOrchestrator.agentId === agentId) {
    activeOrchestrator = null;
  }

  // Clean up prompt cache if exists
  orchestratorPromptCache.delete(agentId);

  console.log(`Orchestrator ${agentId} killed and cleaned up`);
}

/**
 * Get the active orchestrator
 */
export function getActiveOrchestrator(): OrchestratorContext | null {
  return activeOrchestrator;
}

/**
 * Check if orchestrator is running
 */
export function isOrchestratorRunning(agentId: string): boolean {
  return activeOrchestrator?.agentId === agentId && activeOrchestrator?.isRunning === true;
}
