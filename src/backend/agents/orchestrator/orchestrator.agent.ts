/**
 * Orchestrator Agent
 *
 * The orchestrator is the top-level agent that manages all supervisors.
 * It monitors supervisor health, creates supervisors for new epics,
 * and triggers cascading recovery when supervisors crash.
 *
 * There should only be ONE orchestrator instance running at a time.
 */

import { AgentState, AgentType } from '@prisma-gen/client';
import { createWorkerSession } from '../../clients/claude-code.client.js';
import { agentAccessor, decisionLogAccessor } from '../../resource_accessors/index.js';
import { executeMcpTool } from '../../routers/mcp/server.js';
import { startSupervisorForEpic } from '../supervisor/lifecycle.js';
import {
  checkSupervisorHealth,
  getPendingEpicsNeedingSupervisors,
  recoverSupervisor,
} from './health.js';
import { buildOrchestratorPrompt } from './orchestrator.prompts.js';

/**
 * Orchestrator agent context - tracks the running orchestrator
 */
interface OrchestratorContext {
  agentId: string;
  sessionId: string;
  tmuxSessionName: string;
  isRunning: boolean;
  monitoringInterval?: NodeJS.Timeout;
  healthCheckInterval?: NodeJS.Timeout;
  epicCheckInterval?: NodeJS.Timeout;
}

// In-memory store for the active orchestrator (singleton)
let activeOrchestrator: OrchestratorContext | null = null;

/**
 * Health check interval in milliseconds (7 minutes)
 */
const HEALTH_CHECK_INTERVAL_MS = 7 * 60 * 1000;

/**
 * Epic check interval in milliseconds (30 seconds)
 */
const EPIC_CHECK_INTERVAL_MS = 30 * 1000;

/**
 * Monitoring interval in milliseconds (5 seconds)
 */
const MONITORING_INTERVAL_MS = 5 * 1000;

/**
 * Parse tool calls from Claude CLI output
 * Looks for tool use blocks in the captured output
 */
function parseToolCallsFromOutput(output: string): Array<{
  toolId: string;
  toolName: string;
  toolInput: unknown;
}> {
  const toolCalls: Array<{ toolId: string; toolName: string; toolInput: unknown }> = [];

  // Look for tool use patterns in output
  const toolUsePattern = /<tool_use>[\s\S]*?<\/tool_use>/g;
  const matches = output.match(toolUsePattern);

  if (matches) {
    for (const match of matches) {
      // Extract tool name and input from the match
      const nameMatch = match.match(/<tool_name>(.*?)<\/tool_name>/);
      const inputMatch = match.match(/<tool_input>(.*?)<\/tool_input>/s);
      const idMatch = match.match(/id="(.*?)"/);

      if (nameMatch && inputMatch) {
        try {
          toolCalls.push({
            toolId: idMatch ? idMatch[1] : `tool_${Date.now()}`,
            toolName: nameMatch[1],
            toolInput: JSON.parse(inputMatch[1]),
          });
        } catch (e) {
          console.error('Failed to parse tool call:', e);
        }
      }
    }
  }

  return toolCalls;
}

/**
 * Get tmux session name for orchestrator
 */
function getOrchestratorTmuxSessionName(agentId: string): string {
  return `orchestrator-${agentId}`;
}

/**
 * Create a new orchestrator agent
 */
export async function createOrchestrator(): Promise<string> {
  // Check if orchestrator already exists
  const existingOrchestrators = await agentAccessor.findByType(AgentType.ORCHESTRATOR);
  const activeOrchestrators = existingOrchestrators.filter((o) => o.state !== AgentState.FAILED);

  if (activeOrchestrators.length > 0) {
    throw new Error(
      `An orchestrator already exists (${activeOrchestrators[0].id}). Kill it first before creating a new one.`
    );
  }

  // Create agent record
  const agent = await agentAccessor.create({
    type: AgentType.ORCHESTRATOR,
    state: AgentState.IDLE,
  });

  // Build system prompt
  const backendUrl = `http://localhost:${process.env.BACKEND_PORT || 3001}`;
  const systemPrompt = buildOrchestratorPrompt({
    agentId: agent.id,
    backendUrl,
  });

  // Get the repo root directory
  const repoRoot = process.cwd();

  // Create Claude Code session in tmux
  const sessionContext = await createOrchestratorSession(agent.id, systemPrompt, repoRoot);

  // Update agent with session info
  await agentAccessor.update(agent.id, {
    sessionId: sessionContext.sessionId,
    tmuxSessionName: sessionContext.tmuxSessionName,
  });

  console.log(`Created orchestrator ${agent.id}`);
  console.log(`Tmux session: ${sessionContext.tmuxSessionName}`);
  console.log(`Session ID: ${sessionContext.sessionId}`);

  return agent.id;
}

/**
 * Create orchestrator session
 */
async function createOrchestratorSession(
  agentId: string,
  systemPrompt: string,
  workingDir: string
): Promise<{ sessionId: string; tmuxSessionName: string }> {
  // Use the worker session creator but with orchestrator naming
  const context = await createWorkerSession(agentId, systemPrompt, workingDir);

  // Rename tmux session to orchestrator naming
  const orchestratorTmuxName = getOrchestratorTmuxSessionName(agentId);
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    await execAsync(`tmux rename-session -t ${context.tmuxSessionName} ${orchestratorTmuxName}`);
  } catch (error) {
    console.warn(`Could not rename tmux session: ${error}`);
  }

  return {
    sessionId: context.sessionId,
    tmuxSessionName: orchestratorTmuxName,
  };
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

  if (!(agent.sessionId && agent.tmuxSessionName)) {
    throw new Error(`Agent '${agentId}' does not have a Claude session`);
  }

  // Check if already running
  if (activeOrchestrator?.isRunning) {
    throw new Error(`Orchestrator ${activeOrchestrator.agentId} is already running`);
  }

  // Mark orchestrator as running
  const orchestratorContext: OrchestratorContext = {
    agentId,
    sessionId: agent.sessionId,
    tmuxSessionName: agent.tmuxSessionName,
    isRunning: true,
  };
  activeOrchestrator = orchestratorContext;

  // Update agent state
  await agentAccessor.update(agentId, {
    state: AgentState.BUSY,
  });

  console.log(`Starting orchestrator ${agentId}`);

  // Send initial message to Claude
  try {
    await sendOrchestratorMessage(
      agentId,
      'Begin monitoring supervisors and managing epics. Check for pending epics and supervisor health.'
    );
  } catch (error) {
    console.error(`Failed to send initial message to orchestrator ${agentId}:`, error);
    throw error;
  }

  // Start monitoring loop (check for tool calls from Claude)
  orchestratorContext.monitoringInterval = setInterval(async () => {
    await monitorOrchestrator(agentId);
  }, MONITORING_INTERVAL_MS);

  // Start health check loop (check supervisor health)
  orchestratorContext.healthCheckInterval = setInterval(async () => {
    await performHealthCheck(agentId);
  }, HEALTH_CHECK_INTERVAL_MS);

  // Start epic check loop (check for pending epics)
  orchestratorContext.epicCheckInterval = setInterval(async () => {
    await checkForPendingEpics(agentId);
  }, EPIC_CHECK_INTERVAL_MS);

  console.log(
    `Orchestrator ${agentId} is now running. Monitor with: tmux attach -t ${agent.tmuxSessionName}`
  );
}

/**
 * Send message to orchestrator
 */
async function sendOrchestratorMessage(agentId: string, message: string): Promise<void> {
  const tmuxSessionName = getOrchestratorTmuxSessionName(agentId);

  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  // Check session exists
  try {
    await execAsync(`tmux has-session -t ${tmuxSessionName} 2>/dev/null`);
  } catch {
    throw new Error(`Tmux session ${tmuxSessionName} does not exist`);
  }

  // Atomic message sending - pass message via env var to avoid escaping issues
  const cmdStr = `tmux set-buffer -- "$TMUX_MESSAGE" && tmux paste-buffer -t ${tmuxSessionName} && tmux send-keys -t ${tmuxSessionName} Enter`;
  await execAsync(`sh -c '${cmdStr}'`, { env: { ...process.env, TMUX_MESSAGE: message } });
}

/**
 * Capture output from orchestrator tmux session
 */
async function captureOrchestratorOutput(agentId: string, lines: number = 100): Promise<string> {
  const tmuxSessionName = getOrchestratorTmuxSessionName(agentId);

  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  // Check session exists
  try {
    await execAsync(`tmux has-session -t ${tmuxSessionName} 2>/dev/null`);
  } catch {
    throw new Error(`Tmux session ${tmuxSessionName} does not exist`);
  }

  // Capture pane content
  const { stdout } = await execAsync(`tmux capture-pane -t ${tmuxSessionName} -p -S -${lines}`);

  return stdout;
}

/**
 * Monitor orchestrator output and handle tool calls
 */
async function monitorOrchestrator(agentId: string): Promise<void> {
  if (!activeOrchestrator?.isRunning) {
    return;
  }

  try {
    // Capture recent output
    const output = await captureOrchestratorOutput(agentId, 50);

    // Parse tool calls from output
    const toolCalls = parseToolCallsFromOutput(output);

    if (toolCalls.length > 0) {
      console.log(`Orchestrator ${agentId}: Found ${toolCalls.length} tool call(s)`);

      // Execute each tool call
      for (const toolCall of toolCalls) {
        try {
          console.log(`Orchestrator ${agentId}: Executing ${toolCall.toolName}`);

          // Execute tool via MCP
          const result = await executeMcpTool(agentId, toolCall.toolName, toolCall.toolInput);

          // Format result for Claude
          const resultMessage = `Tool ${toolCall.toolName} result:\n${JSON.stringify(result, null, 2)}`;

          // Send result back to Claude
          await sendOrchestratorMessage(agentId, resultMessage);
        } catch (error) {
          console.error(`Orchestrator ${agentId}: Tool ${toolCall.toolName} failed:`, error);

          // Send error back to Claude
          const errorMessage = `Tool ${toolCall.toolName} failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
          await sendOrchestratorMessage(agentId, errorMessage);
        }
      }
    }
  } catch (error) {
    console.error(`Orchestrator ${agentId}: Monitoring error:`, error);
    // Don't stop orchestrator on monitoring errors - they might be transient
  }
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
        const result = await recoverSupervisor(unhealthy.supervisorId, unhealthy.epicId, agentId);

        console.log(`Orchestrator ${agentId}: Recovery result - ${result.message}`);

        // Notify Claude about the recovery
        await sendOrchestratorMessage(
          agentId,
          `[AUTOMATIC HEALTH CHECK] Recovered unhealthy supervisor:\n` +
            `- Epic: ${unhealthy.epicTitle}\n` +
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
 * Check for pending epics that need supervisors
 */
async function checkForPendingEpics(agentId: string): Promise<void> {
  if (!activeOrchestrator?.isRunning) {
    return;
  }

  try {
    const pendingEpics = await getPendingEpicsNeedingSupervisors();

    if (pendingEpics.length > 0) {
      console.log(
        `Orchestrator ${agentId}: Found ${pendingEpics.length} pending epic(s) needing supervisors`
      );

      // Create supervisors for pending epics
      for (const epic of pendingEpics) {
        console.log(
          `Orchestrator ${agentId}: Creating supervisor for epic "${epic.title}" (${epic.epicId})`
        );

        try {
          const supervisorId = await startSupervisorForEpic(epic.epicId);

          console.log(
            `Orchestrator ${agentId}: Created supervisor ${supervisorId} for epic ${epic.epicId}`
          );

          // Notify Claude about the new supervisor
          await sendOrchestratorMessage(
            agentId,
            `[AUTOMATIC EPIC CHECK] Created supervisor for new epic:\n` +
              `- Epic: ${epic.title}\n` +
              `- Epic ID: ${epic.epicId}\n` +
              `- Supervisor ID: ${supervisorId}`
          );

          // Log decision
          await decisionLogAccessor.createManual(
            agentId,
            `Created supervisor for pending epic`,
            `Epic "${epic.title}" was in PLANNING state without a supervisor`,
            JSON.stringify({ epicId: epic.epicId, supervisorId })
          );
        } catch (error) {
          console.error(
            `Orchestrator ${agentId}: Failed to create supervisor for epic ${epic.epicId}:`,
            error
          );
        }
      }
    }
  } catch (error) {
    console.error(`Orchestrator ${agentId}: Epic check error:`, error);
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

  // Clear intervals
  if (activeOrchestrator.monitoringInterval) {
    clearInterval(activeOrchestrator.monitoringInterval);
  }
  if (activeOrchestrator.healthCheckInterval) {
    clearInterval(activeOrchestrator.healthCheckInterval);
  }
  if (activeOrchestrator.epicCheckInterval) {
    clearInterval(activeOrchestrator.epicCheckInterval);
  }

  activeOrchestrator.isRunning = false;

  // Send Ctrl+C to stop Claude
  const tmuxSessionName = getOrchestratorTmuxSessionName(agentId);
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  try {
    await execAsync(`tmux send-keys -t ${tmuxSessionName} C-c`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch {
    // Session may not exist
  }

  // Update agent state
  await agentAccessor.update(agentId, {
    state: AgentState.IDLE,
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

  // Kill tmux session
  const tmuxSessionName = getOrchestratorTmuxSessionName(agentId);
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  try {
    await execAsync(`tmux kill-session -t ${tmuxSessionName}`);
  } catch {
    // Session may not exist
  }

  // Clean up system prompt file
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const systemPromptPath = path.join(os.tmpdir(), `factoryfactory-prompt-${agentId}.txt`);
  try {
    await fs.unlink(systemPromptPath);
  } catch {
    // File may not exist
  }

  // Clear active orchestrator reference
  if (activeOrchestrator && activeOrchestrator.agentId === agentId) {
    activeOrchestrator = null;
  }

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
