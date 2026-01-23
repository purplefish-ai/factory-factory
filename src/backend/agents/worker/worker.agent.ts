import { AgentType, AgentState, TaskState } from '@prisma/client';
import {
  agentAccessor,
  taskAccessor,
  epicAccessor,
} from '../../resource_accessors/index.js';
import {
  createWorkerSession,
  sendMessage,
  captureOutput,
  stopSession,
  killSession,
  getSessionStatus,
} from '../../clients/claude-code.client.js';
import { gitClient } from '../../clients/git.client.js';
import { executeMcpTool } from '../../routers/mcp/server.js';
import { buildWorkerPrompt } from './worker.prompts.js';

/**
 * Worker agent context - tracks running workers
 */
interface WorkerContext {
  agentId: string;
  taskId: string;
  sessionId: string;
  tmuxSessionName: string;
  isRunning: boolean;
  monitoringInterval?: NodeJS.Timeout;
}

// In-memory store for active workers
const activeWorkers = new Map<string, WorkerContext>();

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
  // This is a simplified parser - may need refinement based on actual CLI output format
  const toolUsePattern = /<tool_use>[\s\S]*?<\/tool_use>/g;
  const matches = output.match(toolUsePattern);

  if (matches) {
    for (const match of matches) {
      // Extract tool name and input from the match
      // This regex may need adjustment based on actual format
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
 * Create a new worker agent for a task
 */
export async function createWorker(taskId: string): Promise<string> {
  // Get task
  const task = await taskAccessor.findById(taskId);
  if (!task) {
    throw new Error(`Task with ID '${taskId}' not found`);
  }

  // Get epic
  const epic = await epicAccessor.findById(task.epicId);
  if (!epic) {
    throw new Error(`Epic with ID '${task.epicId}' not found`);
  }

  // Create agent record
  const agent = await agentAccessor.create({
    type: AgentType.WORKER,
    state: AgentState.IDLE,
    currentTaskId: taskId,
  });

  // Create git worktree for task (branching from main)
  const worktreeName = `task-${agent.id.substring(0, 8)}`;
  const worktreeInfo = await gitClient.createWorktree(worktreeName, 'main');

  // Update task with worktree info
  await taskAccessor.update(taskId, {
    assignedAgentId: agent.id,
    worktreePath: worktreeInfo.path,
    branchName: worktreeInfo.branchName,
    state: TaskState.ASSIGNED,
  });

  // Build system prompt with full context
  const systemPrompt = buildWorkerPrompt({
    taskId: task.id,
    taskTitle: task.title,
    taskDescription: task.description || 'No description provided',
    epicTitle: epic.title,
    worktreePath: worktreeInfo.path,
    branchName: worktreeInfo.branchName,
  });

  // Create Claude Code session in tmux
  const sessionContext = await createWorkerSession(
    agent.id,
    systemPrompt,
    worktreeInfo.path
  );

  // Update agent with session info
  await agentAccessor.update(agent.id, {
    sessionId: sessionContext.sessionId,
    tmuxSessionName: sessionContext.tmuxSessionName,
  });

  console.log(`Created worker ${agent.id} for task ${taskId}`);
  console.log(`Tmux session: ${sessionContext.tmuxSessionName}`);
  console.log(`Session ID: ${sessionContext.sessionId}`);

  return agent.id;
}

/**
 * Run a worker agent - starts monitoring and tool execution
 */
export async function runWorker(agentId: string): Promise<void> {
  // Get agent
  const agent = await agentAccessor.findById(agentId);
  if (!agent) {
    throw new Error(`Agent with ID '${agentId}' not found`);
  }

  if (agent.type !== AgentType.WORKER) {
    throw new Error(`Agent '${agentId}' is not a WORKER`);
  }

  if (!agent.currentTaskId) {
    throw new Error(`Agent '${agentId}' does not have a task assigned`);
  }

  if (!agent.sessionId || !agent.tmuxSessionName) {
    throw new Error(`Agent '${agentId}' does not have a Claude session`);
  }

  // Get task
  const task = await taskAccessor.findById(agent.currentTaskId);
  if (!task) {
    throw new Error(`Task with ID '${agent.currentTaskId}' not found`);
  }

  // Check if already running
  if (activeWorkers.has(agentId)) {
    throw new Error(`Worker ${agentId} is already running`);
  }

  // Mark worker as running
  const workerContext: WorkerContext = {
    agentId,
    taskId: task.id,
    sessionId: agent.sessionId,
    tmuxSessionName: agent.tmuxSessionName,
    isRunning: true,
  };
  activeWorkers.set(agentId, workerContext);

  // Update agent state
  await agentAccessor.update(agentId, {
    state: AgentState.BUSY,
  });

  console.log(`Starting worker ${agentId}`);

  // Send initial message to Claude
  try {
    await sendMessage(agentId, 'Check your task assignment and begin work.');
  } catch (error) {
    console.error(`Failed to send initial message to worker ${agentId}:`, error);
    throw error;
  }

  // Start monitoring loop
  workerContext.monitoringInterval = setInterval(async () => {
    await monitorWorker(agentId);
  }, 5000); // Check every 5 seconds

  console.log(`Worker ${agentId} is now running. Monitor with: tmux attach -t ${agent.tmuxSessionName}`);
}

/**
 * Monitor worker output and handle tool calls
 */
async function monitorWorker(agentId: string): Promise<void> {
  const workerContext = activeWorkers.get(agentId);
  if (!workerContext || !workerContext.isRunning) {
    return;
  }

  try {
    // Check if Claude session is still running
    const status = await getSessionStatus(agentId);
    if (!status.running && status.exists) {
      // Claude finished or crashed
      console.log(`Worker ${agentId}: Claude process has stopped`);
      await handleWorkerCompletion(agentId, 'Claude process stopped');
      return;
    }

    // Capture recent output
    const output = await captureOutput(agentId, 50);

    // Parse tool calls from output
    const toolCalls = parseToolCallsFromOutput(output);

    if (toolCalls.length > 0) {
      console.log(`Worker ${agentId}: Found ${toolCalls.length} tool call(s)`);

      // Execute each tool call
      for (const toolCall of toolCalls) {
        try {
          console.log(`Worker ${agentId}: Executing ${toolCall.toolName}`);

          // Execute tool via MCP
          const result = await executeMcpTool(
            agentId,
            toolCall.toolName,
            toolCall.toolInput
          );

          // Format result for Claude
          const resultMessage = `Tool ${toolCall.toolName} result:\n${JSON.stringify(result, null, 2)}`;

          // Send result back to Claude
          await sendMessage(agentId, resultMessage);
        } catch (error) {
          console.error(`Worker ${agentId}: Tool ${toolCall.toolName} failed:`, error);

          // Send error back to Claude
          const errorMessage = `Tool ${toolCall.toolName} failed: ${error instanceof Error ? error.message : String(error)}`;
          await sendMessage(agentId, errorMessage);
        }
      }
    }
  } catch (error) {
    console.error(`Worker ${agentId}: Monitoring error:`, error);
    // Don't stop worker on monitoring errors - they might be transient
  }
}

/**
 * Handle worker completion (success or failure)
 */
async function handleWorkerCompletion(agentId: string, reason: string): Promise<void> {
  const workerContext = activeWorkers.get(agentId);
  if (!workerContext) {
    return;
  }

  console.log(`Worker ${agentId} completed: ${reason}`);

  // Stop monitoring
  if (workerContext.monitoringInterval) {
    clearInterval(workerContext.monitoringInterval);
  }

  workerContext.isRunning = false;

  // Update agent state
  await agentAccessor.update(agentId, {
    state: AgentState.IDLE,
  });

  // Check task state to determine if successful
  const task = await taskAccessor.findById(workerContext.taskId);
  if (task && task.state !== TaskState.REVIEW && task.state !== TaskState.COMPLETED) {
    // Worker stopped but task not in review - likely failed
    await taskAccessor.update(workerContext.taskId, {
      state: TaskState.FAILED,
      failureReason: reason,
    });
  }
}

/**
 * Stop a running worker agent gracefully
 */
export async function stopWorker(agentId: string): Promise<void> {
  const workerContext = activeWorkers.get(agentId);
  if (!workerContext) {
    throw new Error(`Worker ${agentId} is not running`);
  }

  console.log(`Stopping worker ${agentId}`);

  // Stop monitoring
  if (workerContext.monitoringInterval) {
    clearInterval(workerContext.monitoringInterval);
  }

  workerContext.isRunning = false;

  // Stop Claude session
  await stopSession(agentId);

  // Update agent state
  await agentAccessor.update(agentId, {
    state: AgentState.IDLE,
  });

  console.log(`Worker ${agentId} stopped`);
}

/**
 * Kill a worker agent and clean up resources
 */
export async function killWorker(agentId: string): Promise<void> {
  console.log(`Killing worker ${agentId}`);

  // Stop worker if running
  try {
    await stopWorker(agentId);
  } catch {
    // Worker may not be running
  }

  // Get agent
  const agent = await agentAccessor.findById(agentId);
  if (!agent) {
    throw new Error(`Agent with ID '${agentId}' not found`);
  }

  // Kill Claude session and cleanup
  await killSession(agentId);

  // Delete worktree if task exists
  if (agent.currentTaskId) {
    const task = await taskAccessor.findById(agent.currentTaskId);
    if (task && task.worktreePath) {
      const worktreeName = task.worktreePath.split('/').pop();
      if (worktreeName) {
        try {
          await gitClient.deleteWorktree(worktreeName);
        } catch {
          // Worktree may not exist
        }
      }
    }
  }

  // Remove from active workers
  activeWorkers.delete(agentId);

  console.log(`Worker ${agentId} killed and cleaned up`);
}

/**
 * Get list of active workers
 */
export function getActiveWorkers(): WorkerContext[] {
  return Array.from(activeWorkers.values());
}

/**
 * Check if a worker is running
 */
export function isWorkerRunning(agentId: string): boolean {
  const workerContext = activeWorkers.get(agentId);
  return workerContext?.isRunning ?? false;
}
