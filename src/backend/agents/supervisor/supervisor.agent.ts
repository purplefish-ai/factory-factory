import { AgentState, AgentType, EpicState } from '@prisma-gen/client';
import { createWorkerSession } from '../../clients/claude-code.client.js';
import { gitClient } from '../../clients/git.client.js';
import {
  agentAccessor,
  epicAccessor,
  mailAccessor,
  taskAccessor,
} from '../../resource_accessors/index.js';
import { executeMcpTool } from '../../routers/mcp/server.js';
import { checkWorkerHealth, recoverWorker } from './health.js';
import { buildSupervisorPrompt } from './supervisor.prompts.js';

/**
 * Supervisor agent context - tracks running supervisors
 */
interface SupervisorContext {
  agentId: string;
  epicId: string;
  sessionId: string;
  tmuxSessionName: string;
  isRunning: boolean;
  monitoringInterval?: NodeJS.Timeout;
  inboxCheckInterval?: NodeJS.Timeout;
  workerHealthCheckInterval?: NodeJS.Timeout;
  // Track what we've already notified about to avoid spam
  lastNotifiedMailIds: Set<string>;
  lastNotifiedReviewTaskIds: Set<string>;
  lastNotifiedAllComplete: boolean;
}

// In-memory store for active supervisors
const activeSupervisors = new Map<string, SupervisorContext>();

/**
 * Parse tool calls from Claude CLI output
 * Looks for tool use blocks in the captured output
 */
function parseToolCallsFromOutput(output: string): Array<{
  toolId: string;
  toolName: string;
  toolInput: any;
}> {
  const toolCalls: Array<{ toolId: string; toolName: string; toolInput: any }> = [];

  // Look for tool use patterns in output
  // Claude CLI outputs tool calls in a specific format
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
 * Get tmux session name for supervisor
 */
function getSupervisorTmuxSessionName(agentId: string): string {
  return `supervisor-${agentId}`;
}

/**
 * Create a new supervisor agent for an epic
 */
export async function createSupervisor(epicId: string): Promise<string> {
  // Get epic
  const epic = await epicAccessor.findById(epicId);
  if (!epic) {
    throw new Error(`Epic with ID '${epicId}' not found`);
  }

  // Check if epic already has a supervisor
  const existingSupervisor = await agentAccessor.findByEpicId(epicId);
  if (existingSupervisor) {
    throw new Error(`Epic '${epicId}' already has a supervisor agent (${existingSupervisor.id})`);
  }

  // Create agent record
  const agent = await agentAccessor.create({
    type: AgentType.SUPERVISOR,
    state: AgentState.IDLE,
    currentEpicId: epicId,
  });

  // Create git worktree for epic (branching from main)
  const worktreeName = `epic-${epic.id.substring(0, 8)}`;
  const worktreeInfo = await gitClient.createWorktree(worktreeName, 'main');

  // Update epic state to IN_PROGRESS
  await epicAccessor.update(epicId, {
    state: EpicState.IN_PROGRESS,
  });

  // Build system prompt with full context
  const backendUrl = `http://localhost:${process.env.BACKEND_PORT || 3001}`;
  const systemPrompt = buildSupervisorPrompt({
    epicId: epic.id,
    epicTitle: epic.title,
    epicDescription: epic.description || 'No description provided',
    epicBranchName: worktreeInfo.branchName,
    worktreePath: worktreeInfo.path,
    agentId: agent.id,
    backendUrl,
  });

  // Create Claude Code session in tmux
  // Note: We need to modify createWorkerSession to support supervisors
  // For now, we use the same function but with supervisor tmux naming
  const sessionContext = await createSupervisorSession(agent.id, systemPrompt, worktreeInfo.path);

  // Update agent with session info
  await agentAccessor.update(agent.id, {
    sessionId: sessionContext.sessionId,
    tmuxSessionName: sessionContext.tmuxSessionName,
  });

  console.log(`Created supervisor ${agent.id} for epic ${epicId}`);
  console.log(`Tmux session: ${sessionContext.tmuxSessionName}`);
  console.log(`Session ID: ${sessionContext.sessionId}`);

  return agent.id;
}

/**
 * Create supervisor session (similar to worker but with different naming)
 */
async function createSupervisorSession(
  agentId: string,
  systemPrompt: string,
  workingDir: string
): Promise<{ sessionId: string; tmuxSessionName: string }> {
  // Use the worker session creator but with supervisor naming
  // This is a workaround - ideally we'd have a generic session creator
  const context = await createWorkerSession(agentId, systemPrompt, workingDir);

  // Rename tmux session to supervisor naming
  const supervisorTmuxName = getSupervisorTmuxSessionName(agentId);
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    await execAsync(`tmux rename-session -t ${context.tmuxSessionName} ${supervisorTmuxName}`);
  } catch (error) {
    console.warn(`Could not rename tmux session: ${error}`);
  }

  return {
    sessionId: context.sessionId,
    tmuxSessionName: supervisorTmuxName,
  };
}

/**
 * Run a supervisor agent - starts monitoring and tool execution
 */
export async function runSupervisor(agentId: string): Promise<void> {
  // Get agent
  const agent = await agentAccessor.findById(agentId);
  if (!agent) {
    throw new Error(`Agent with ID '${agentId}' not found`);
  }

  if (agent.type !== AgentType.SUPERVISOR) {
    throw new Error(`Agent '${agentId}' is not a SUPERVISOR`);
  }

  if (!agent.currentEpicId) {
    throw new Error(`Agent '${agentId}' does not have an epic assigned`);
  }

  if (!agent.sessionId || !agent.tmuxSessionName) {
    throw new Error(`Agent '${agentId}' does not have a Claude session`);
  }

  // Get epic
  const epic = await epicAccessor.findById(agent.currentEpicId);
  if (!epic) {
    throw new Error(`Epic with ID '${agent.currentEpicId}' not found`);
  }

  // Check if already running
  if (activeSupervisors.has(agentId)) {
    throw new Error(`Supervisor ${agentId} is already running`);
  }

  // Mark supervisor as running
  const supervisorContext: SupervisorContext = {
    agentId,
    epicId: epic.id,
    sessionId: agent.sessionId,
    tmuxSessionName: agent.tmuxSessionName,
    isRunning: true,
    lastNotifiedMailIds: new Set(),
    lastNotifiedReviewTaskIds: new Set(),
    lastNotifiedAllComplete: false,
  };
  activeSupervisors.set(agentId, supervisorContext);

  // Update agent state
  await agentAccessor.update(agentId, {
    state: AgentState.BUSY,
  });

  console.log(`Starting supervisor ${agentId}`);

  // Send initial message to Claude
  try {
    await sendSupervisorMessage(
      agentId,
      'Review the epic description and break it down into tasks. Use the mcp__epic__create_task tool to create each task.'
    );
  } catch (error) {
    console.error(`Failed to send initial message to supervisor ${agentId}:`, error);
    throw error;
  }

  // Start monitoring loop
  supervisorContext.monitoringInterval = setInterval(async () => {
    await monitorSupervisor(agentId);
  }, 5000); // Check every 5 seconds

  // Start inbox check loop (30 seconds to avoid spamming)
  supervisorContext.inboxCheckInterval = setInterval(async () => {
    await checkSupervisorInbox(agentId);
  }, 30000); // Check every 30 seconds

  // Start worker health check loop (7 minutes)
  supervisorContext.workerHealthCheckInterval = setInterval(
    async () => {
      await performWorkerHealthCheck(agentId);
    },
    7 * 60 * 1000
  ); // Check every 7 minutes

  console.log(
    `Supervisor ${agentId} is now running. Monitor with: tmux attach -t ${agent.tmuxSessionName}`
  );
}

/**
 * Send message to supervisor (using supervisor tmux session naming)
 */
async function sendSupervisorMessage(agentId: string, message: string): Promise<void> {
  const tmuxSessionName = getSupervisorTmuxSessionName(agentId);

  // Use the same atomic pattern as worker
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  // Check session exists
  try {
    await execAsync(`tmux has-session -t ${tmuxSessionName} 2>/dev/null`);
  } catch {
    throw new Error(`Tmux session ${tmuxSessionName} does not exist`);
  }

  // Atomic message sending
  const cmdStr = `tmux set-buffer -- "$1" && tmux paste-buffer -t ${tmuxSessionName} && tmux send-keys -t ${tmuxSessionName} Enter`;
  await execAsync(`sh -c '${cmdStr}' sh "${message.replace(/"/g, '\\"').replace(/'/g, "'\\''")}"`);
}

/**
 * Capture output from supervisor tmux session
 */
async function captureSupervisorOutput(agentId: string, lines: number = 100): Promise<string> {
  const tmuxSessionName = getSupervisorTmuxSessionName(agentId);

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
 * Monitor supervisor output and handle tool calls
 */
async function monitorSupervisor(agentId: string): Promise<void> {
  const supervisorContext = activeSupervisors.get(agentId);
  if (!supervisorContext || !supervisorContext.isRunning) {
    return;
  }

  try {
    // Capture recent output
    const output = await captureSupervisorOutput(agentId, 50);

    // Parse tool calls from output
    const toolCalls = parseToolCallsFromOutput(output);

    if (toolCalls.length > 0) {
      console.log(`Supervisor ${agentId}: Found ${toolCalls.length} tool call(s)`);

      // Execute each tool call
      for (const toolCall of toolCalls) {
        try {
          console.log(`Supervisor ${agentId}: Executing ${toolCall.toolName}`);

          // Execute tool via MCP
          const result = await executeMcpTool(agentId, toolCall.toolName, toolCall.toolInput);

          // Format result for Claude
          const resultMessage = `Tool ${toolCall.toolName} result:\n${JSON.stringify(result, null, 2)}`;

          // Send result back to Claude
          await sendSupervisorMessage(agentId, resultMessage);
        } catch (error) {
          console.error(`Supervisor ${agentId}: Tool ${toolCall.toolName} failed:`, error);

          // Send error back to Claude
          const errorMessage = `Tool ${toolCall.toolName} failed: ${error instanceof Error ? error.message : String(error)}`;
          await sendSupervisorMessage(agentId, errorMessage);
        }
      }
    }
  } catch (error) {
    console.error(`Supervisor ${agentId}: Monitoring error:`, error);
    // Don't stop supervisor on monitoring errors - they might be transient
  }
}

/**
 * Check supervisor inbox for worker messages and task status
 * Only notifies about NEW items to avoid spamming
 */
async function checkSupervisorInbox(agentId: string): Promise<void> {
  const supervisorContext = activeSupervisors.get(agentId);
  if (!supervisorContext || !supervisorContext.isRunning) {
    return;
  }

  try {
    // Get unread mail for supervisor
    const inbox = await mailAccessor.listInbox(agentId, false);

    // Filter to only NEW mail we haven't notified about
    const newMail = inbox.filter((m) => !supervisorContext.lastNotifiedMailIds.has(m.id));

    if (newMail.length > 0) {
      console.log(`Supervisor ${agentId}: Found ${newMail.length} NEW unread mail(s)`);

      // Track that we've notified about these
      for (const mail of newMail) {
        supervisorContext.lastNotifiedMailIds.add(mail.id);
      }

      // Notify supervisor about new mail
      const mailSummary = newMail
        .map((m) => `- From ${m.fromAgentId || 'unknown'}: ${m.subject}`)
        .join('\n');

      await sendSupervisorMessage(
        agentId,
        `You have ${newMail.length} new message(s) in your inbox:\n${mailSummary}\n\nUse mcp__mail__read to read them.`
      );
    }

    // Also check task status and prompt supervisor if there are tasks ready for review
    const tasks = await taskAccessor.list({ epicId: supervisorContext.epicId });
    const reviewTasks = tasks.filter((t) => t.state === 'REVIEW');
    const completedTasks = tasks.filter((t) => t.state === 'COMPLETED');
    const failedTasks = tasks.filter((t) => t.state === 'FAILED');
    const inProgressTasks = tasks.filter(
      (t) => t.state === 'IN_PROGRESS' || t.state === 'ASSIGNED'
    );

    // Filter to only NEW review tasks we haven't notified about
    const newReviewTasks = reviewTasks.filter(
      (t) => !supervisorContext.lastNotifiedReviewTaskIds.has(t.id)
    );

    // If there are NEW tasks ready for review, prompt supervisor
    if (newReviewTasks.length > 0) {
      console.log(`Supervisor ${agentId}: ${newReviewTasks.length} NEW task(s) ready for review`);

      // Track that we've notified about these
      for (const task of newReviewTasks) {
        supervisorContext.lastNotifiedReviewTaskIds.add(task.id);
      }

      await sendSupervisorMessage(
        agentId,
        `📋 NEW TASKS READY FOR REVIEW:\n` +
          `${newReviewTasks.map((t) => `- ${t.title} (${t.id})`).join('\n')}\n\n` +
          `Total status: ${reviewTasks.length} in review, ${inProgressTasks.length} in progress, ${completedTasks.length} completed, ${failedTasks.length} failed\n\n` +
          `Use mcp__epic__get_review_queue to see the full review queue.`
      );
    }
    // If all tasks are done and we haven't notified yet, prompt to create epic PR
    else if (tasks.length > 0 && inProgressTasks.length === 0 && reviewTasks.length === 0) {
      const allDone = completedTasks.length + failedTasks.length === tasks.length;
      if (allDone && !supervisorContext.lastNotifiedAllComplete) {
        supervisorContext.lastNotifiedAllComplete = true;
        console.log(`Supervisor ${agentId}: All tasks complete, prompting for epic PR`);
        await sendSupervisorMessage(
          agentId,
          `🎉 ALL TASKS COMPLETE!\n` +
            `- ${completedTasks.length} task(s) completed successfully\n` +
            `- ${failedTasks.length} task(s) failed\n\n` +
            `It's time to create the final PR from the epic branch to main.\n` +
            `Use mcp__epic__create_epic_pr to create the epic PR.`
        );
      }
    }
  } catch (error) {
    console.error(`Supervisor ${agentId}: Inbox check error:`, error);
  }
}

/**
 * Perform worker health check
 * Checks all workers for this supervisor's epic and triggers recovery for unhealthy ones
 */
async function performWorkerHealthCheck(agentId: string): Promise<void> {
  const supervisorContext = activeSupervisors.get(agentId);
  if (!supervisorContext || !supervisorContext.isRunning) {
    return;
  }

  try {
    console.log(`Supervisor ${agentId}: Performing worker health check...`);

    const { healthyWorkers, unhealthyWorkers } = await checkWorkerHealth(agentId);

    console.log(
      `Supervisor ${agentId}: Worker health check complete. Healthy: ${healthyWorkers.length}, Unhealthy: ${unhealthyWorkers.length}`
    );

    // Trigger recovery for unhealthy workers
    for (const unhealthy of unhealthyWorkers) {
      console.log(
        `Supervisor ${agentId}: Worker ${unhealthy.workerId} is unhealthy (${unhealthy.minutesSinceHeartbeat} minutes since heartbeat). Triggering recovery...`
      );

      try {
        const result = await recoverWorker(unhealthy.workerId, unhealthy.taskId, agentId);

        console.log(`Supervisor ${agentId}: Worker recovery result - ${result.message}`);

        // Notify supervisor Claude about the recovery
        if (result.permanentFailure) {
          await sendSupervisorMessage(
            agentId,
            `[AUTOMATIC WORKER HEALTH CHECK] Worker permanently failed:\n` +
              `- Task ID: ${unhealthy.taskId}\n` +
              `- Old Worker: ${unhealthy.workerId}\n` +
              `- Reason: Max recovery attempts (${result.attemptNumber}) reached\n\n` +
              `The task has been marked as FAILED. You may need to manually investigate or mark it complete using mcp__epic__force_complete_task.`
          );
        } else if (result.success) {
          await sendSupervisorMessage(
            agentId,
            `[AUTOMATIC WORKER HEALTH CHECK] Recovered unhealthy worker:\n` +
              `- Task ID: ${unhealthy.taskId}\n` +
              `- Old Worker: ${unhealthy.workerId}\n` +
              `- New Worker: ${result.newWorkerId}\n` +
              `- Recovery Attempt: ${result.attemptNumber}/5`
          );
        }
      } catch (error) {
        console.error(
          `Supervisor ${agentId}: Failed to recover worker ${unhealthy.workerId}:`,
          error
        );
      }
    }
  } catch (error) {
    console.error(`Supervisor ${agentId}: Worker health check error:`, error);
  }
}

/**
 * Handle supervisor completion (success or failure)
 * Exported for use by lifecycle management
 */
export async function handleSupervisorCompletion(agentId: string, reason: string): Promise<void> {
  const supervisorContext = activeSupervisors.get(agentId);
  if (!supervisorContext) {
    return;
  }

  console.log(`Supervisor ${agentId} completed: ${reason}`);

  // Stop monitoring
  if (supervisorContext.monitoringInterval) {
    clearInterval(supervisorContext.monitoringInterval);
  }
  if (supervisorContext.inboxCheckInterval) {
    clearInterval(supervisorContext.inboxCheckInterval);
  }
  if (supervisorContext.workerHealthCheckInterval) {
    clearInterval(supervisorContext.workerHealthCheckInterval);
  }

  supervisorContext.isRunning = false;

  // Update agent state
  await agentAccessor.update(agentId, {
    state: AgentState.IDLE,
  });
}

/**
 * Stop a running supervisor agent gracefully
 */
export async function stopSupervisor(agentId: string): Promise<void> {
  const supervisorContext = activeSupervisors.get(agentId);
  if (!supervisorContext) {
    throw new Error(`Supervisor ${agentId} is not running`);
  }

  console.log(`Stopping supervisor ${agentId}`);

  // Stop monitoring
  if (supervisorContext.monitoringInterval) {
    clearInterval(supervisorContext.monitoringInterval);
  }
  if (supervisorContext.inboxCheckInterval) {
    clearInterval(supervisorContext.inboxCheckInterval);
  }
  if (supervisorContext.workerHealthCheckInterval) {
    clearInterval(supervisorContext.workerHealthCheckInterval);
  }

  supervisorContext.isRunning = false;

  // Stop Claude session
  const tmuxSessionName = getSupervisorTmuxSessionName(agentId);
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

  console.log(`Supervisor ${agentId} stopped`);
}

/**
 * Kill a supervisor agent and clean up resources
 */
export async function killSupervisor(agentId: string): Promise<void> {
  console.log(`Killing supervisor ${agentId}`);

  // Stop supervisor if running
  try {
    await stopSupervisor(agentId);
  } catch {
    // Supervisor may not be running
  }

  // Get agent
  const agent = await agentAccessor.findById(agentId);
  if (!agent) {
    throw new Error(`Agent with ID '${agentId}' not found`);
  }

  // Kill tmux session
  const tmuxSessionName = getSupervisorTmuxSessionName(agentId);
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  try {
    await execAsync(`tmux kill-session -t ${tmuxSessionName}`);
  } catch {
    // Session may not exist
  }

  // Delete worktree if epic exists
  if (agent.currentEpicId) {
    const worktreeName = `epic-${agent.currentEpicId.substring(0, 8)}`;
    try {
      await gitClient.deleteWorktree(worktreeName);
    } catch {
      // Worktree may not exist
    }
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

  // Remove from active supervisors
  activeSupervisors.delete(agentId);

  console.log(`Supervisor ${agentId} killed and cleaned up`);
}

/**
 * Get list of active supervisors
 */
export function getActiveSupervisors(): SupervisorContext[] {
  return Array.from(activeSupervisors.values());
}

/**
 * Check if a supervisor is running
 */
export function isSupervisorRunning(agentId: string): boolean {
  const supervisorContext = activeSupervisors.get(agentId);
  return supervisorContext?.isRunning ?? false;
}
