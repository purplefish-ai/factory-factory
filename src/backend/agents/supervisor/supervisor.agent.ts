import { AgentType, DesiredExecutionState, ExecutionState, TaskState } from '@prisma-gen/client';
import { GitClientFactory } from '../../clients/git.client.js';
import { agentAccessor, mailAccessor, taskAccessor } from '../../resource_accessors/index.js';
import { getTopLevelTaskWorktreeName } from '../../routers/mcp/helpers.js';
import { type AgentProcessEvents, agentProcessAdapter } from '../process-adapter.js';
import { buildSupervisorPrompt } from '../prompts/builders/supervisor.builder.js';
import { promptFileManager } from '../prompts/file-manager.js';
import { checkWorkerHealth, recoverWorker } from './health.js';

/**
 * Supervisor agent context - tracks running supervisors
 */
interface SupervisorContext {
  agentId: string;
  topLevelTaskId: string;
  isRunning: boolean;
  inboxCheckInterval?: NodeJS.Timeout;
  workerHealthCheckInterval?: NodeJS.Timeout;
  eventCleanup?: () => void;
  // Track what we've already notified about to avoid spam
  lastNotifiedMailIds: Set<string>;
  lastNotifiedReviewTaskIds: Set<string>;
  lastNotifiedAllComplete: boolean;
}

// In-memory store for active supervisors
const activeSupervisors = new Map<string, SupervisorContext>();

// Cache for supervisor prompts (used between createSupervisor and runSupervisor)
const supervisorPromptCache = new Map<
  string,
  {
    systemPrompt: string;
    workingDir: string;
    resumeSessionId?: string;
  }
>();

export interface CreateSupervisorOptions {
  /** If provided, resume an existing Claude session instead of starting fresh */
  resumeSessionId?: string;
}

/**
 * Create a new supervisor agent for a top-level task (epic)
 * If resumeSessionId is provided, the Claude session will resume with conversation history
 */
export async function createSupervisor(
  taskId: string,
  options?: CreateSupervisorOptions
): Promise<string> {
  // Get top-level task (includes project relation)
  const topLevelTask = await taskAccessor.findById(taskId);
  if (!topLevelTask) {
    throw new Error(`Task with ID '${taskId}' not found`);
  }

  // Get project for this task
  const project = topLevelTask.project;
  if (!project) {
    throw new Error(`Task '${taskId}' does not have an associated project`);
  }

  // Check if task already has a supervisor
  const existingSupervisor = await agentAccessor.findByTopLevelTaskId(taskId);
  if (existingSupervisor) {
    throw new Error(`Task '${taskId}' already has a supervisor agent (${existingSupervisor.id})`);
  }

  // Create agent record
  const agent = await agentAccessor.create({
    type: AgentType.SUPERVISOR,
    executionState: ExecutionState.IDLE,
    desiredExecutionState: DesiredExecutionState.IDLE,
    currentTaskId: taskId,
  });

  // Get project-specific GitClient
  const gitClient = GitClientFactory.forProject({
    repoPath: project.repoPath,
    worktreeBasePath: project.worktreeBasePath,
  });

  // Create git worktree for task (branching from project's default branch)
  const worktreeName = getTopLevelTaskWorktreeName(topLevelTask.id);
  const worktreeInfo = await gitClient.createWorktree(worktreeName, project.defaultBranch);

  // Update task state to IN_PROGRESS
  await taskAccessor.update(taskId, {
    state: TaskState.IN_PROGRESS,
  });

  // Build system prompt with full context
  const backendUrl = `http://localhost:${process.env.BACKEND_PORT || 3001}`;
  const systemPrompt = buildSupervisorPrompt({
    taskId: topLevelTask.id,
    taskTitle: topLevelTask.title,
    taskDescription: topLevelTask.description || 'No description provided',
    taskBranchName: worktreeInfo.branchName,
    worktreePath: worktreeInfo.path,
    agentId: agent.id,
    backendUrl,
  });

  // Update agent with worktree path and session info (if resuming)
  await agentAccessor.update(agent.id, {
    worktreePath: worktreeInfo.path,
    ...(options?.resumeSessionId && { sessionId: options.resumeSessionId }),
  });

  // Store prompt for use when starting the agent
  // The adapter will use this when startAgent is called
  supervisorPromptCache.set(agent.id, {
    systemPrompt,
    workingDir: worktreeInfo.path,
    resumeSessionId: options?.resumeSessionId,
  });

  console.log(`Created supervisor ${agent.id} for task ${taskId}`);
  console.log(`Worktree: ${worktreeInfo.path}`);

  return agent.id;
}

/**
 * Run a supervisor agent - starts the Claude process and sets up event handlers
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

  if (!agent.currentTaskId) {
    throw new Error(`Agent '${agentId}' does not have a task assigned`);
  }

  // Check if already running
  if (activeSupervisors.has(agentId)) {
    throw new Error(`Supervisor ${agentId} is already running`);
  }

  // Get cached prompt info
  const promptInfo = supervisorPromptCache.get(agentId);
  if (!promptInfo) {
    throw new Error(`No prompt info found for agent ${agentId}. Was createSupervisor called?`);
  }

  // Get task
  const topLevelTask = await taskAccessor.findById(agent.currentTaskId);
  if (!topLevelTask) {
    throw new Error(`Task with ID '${agent.currentTaskId}' not found`);
  }

  // Create supervisor context
  const supervisorContext: SupervisorContext = {
    agentId,
    topLevelTaskId: topLevelTask.id,
    isRunning: true,
    lastNotifiedMailIds: new Set(),
    lastNotifiedReviewTaskIds: new Set(),
    lastNotifiedAllComplete: false,
  };
  activeSupervisors.set(agentId, supervisorContext);

  // Update agent state
  await agentAccessor.update(agentId, {
    executionState: ExecutionState.ACTIVE,
  });

  console.log(`Starting supervisor ${agentId}`);

  // Set up event handlers for the adapter
  const handleMessage = (event: AgentProcessEvents['message']) => {
    if (event.agentId !== agentId) {
      return;
    }

    const msg = event.message;

    // Log messages for debugging based on type
    // Note: tool_use and tool_result are now separate events, not message types
    if (msg.type === 'assistant') {
      console.log(`Supervisor ${agentId}: Assistant message received`);
    }
  };

  const handleResult = async (event: AgentProcessEvents['result']) => {
    if (event.agentId !== agentId) {
      return;
    }

    console.log(`Supervisor ${agentId}: Session completed`);
    console.log(`  Claude Session ID: ${event.claudeSessionId}`);
    console.log(`  Turns: ${event.numTurns}`);
    console.log(`  Duration: ${event.durationMs}ms`);
    console.log(`  Cost: $${event.totalCostUsd?.toFixed(4) || 'N/A'}`);

    // Store Claude session ID for potential resume
    await agentAccessor.update(agentId, {
      sessionId: event.claudeSessionId,
    });

    // Handle completion
    await handleSupervisorCompletion(agentId, 'Claude session completed');
  };

  const handleError = (event: AgentProcessEvents['error']) => {
    if (event.agentId !== agentId) {
      return;
    }

    console.error(`Supervisor ${agentId}: Error - ${event.error.message}`);

    // Don't stop the supervisor on errors - adapter handles recovery
  };

  const handleExit = async (event: AgentProcessEvents['exit']) => {
    if (event.agentId !== agentId) {
      return;
    }

    console.log(`Supervisor ${agentId}: Process exited with code ${event.code}`);

    if (event.sessionId) {
      // Store session ID for potential resume
      await agentAccessor.update(agentId, {
        sessionId: event.sessionId,
      });
    }

    // Handle completion based on exit code
    const reason =
      event.code === 0 ? 'Process exited normally' : `Process exited with code ${event.code}`;
    await handleSupervisorCompletion(agentId, reason);
  };

  // Register event handlers
  agentProcessAdapter.on('message', handleMessage);
  agentProcessAdapter.on('result', handleResult);
  agentProcessAdapter.on('error', handleError);
  agentProcessAdapter.on('exit', handleExit);

  // Store cleanup function
  supervisorContext.eventCleanup = () => {
    agentProcessAdapter.off('message', handleMessage);
    agentProcessAdapter.off('result', handleResult);
    agentProcessAdapter.off('error', handleError);
    agentProcessAdapter.off('exit', handleExit);
  };

  // Start inbox check timer for worker messages (30 seconds to avoid spamming)
  supervisorContext.inboxCheckInterval = setInterval(async () => {
    await checkSupervisorInbox(agentId);
  }, 30_000); // Check every 30 seconds

  // Start worker health check timer (7 minutes)
  supervisorContext.workerHealthCheckInterval = setInterval(
    async () => {
      await performWorkerHealthCheck(agentId);
    },
    7 * 60 * 1000
  ); // Check every 7 minutes

  // Start the Claude process via the adapter
  try {
    const model = process.env.SUPERVISOR_MODEL || 'claude-sonnet-4-5-20250929';
    const initialPrompt =
      'Review the top-level task description and break it down into subtasks. Use the mcp__task__create tool to create each subtask.';

    await agentProcessAdapter.startAgent({
      agentId,
      agentType: 'supervisor',
      workingDir: promptInfo.workingDir,
      systemPrompt: promptInfo.systemPrompt,
      initialPrompt,
      model,
      resumeSessionId: promptInfo.resumeSessionId,
    });

    console.log(`Supervisor ${agentId} is now running`);

    // Clean up prompt cache after starting
    supervisorPromptCache.delete(agentId);
  } catch (error) {
    // Clean up on startup failure
    cleanupSupervisorContext(agentId);
    throw error;
  }
}

/**
 * Clean up supervisor context (intervals and event handlers)
 */
function cleanupSupervisorContext(agentId: string): void {
  const supervisorContext = activeSupervisors.get(agentId);
  if (!supervisorContext) {
    return;
  }

  // Clear inbox check interval
  if (supervisorContext.inboxCheckInterval) {
    clearInterval(supervisorContext.inboxCheckInterval);
  }

  // Clear worker health check interval
  if (supervisorContext.workerHealthCheckInterval) {
    clearInterval(supervisorContext.workerHealthCheckInterval);
  }

  // Clean up event handlers
  if (supervisorContext.eventCleanup) {
    supervisorContext.eventCleanup();
  }

  supervisorContext.isRunning = false;
}

/**
 * Handle supervisor completion (success or failure)
 */
async function handleSupervisorCompletion(agentId: string, reason: string): Promise<void> {
  const supervisorContext = activeSupervisors.get(agentId);
  if (!supervisorContext) {
    return;
  }

  console.log(`Supervisor ${agentId} completed: ${reason}`);

  // Clean up context
  cleanupSupervisorContext(agentId);

  // Update agent state
  await agentAccessor.update(agentId, {
    executionState: ExecutionState.IDLE,
  });

  // Check top-level task state to determine if successful
  const task = await taskAccessor.findById(supervisorContext.topLevelTaskId);
  if (task && task.state !== TaskState.REVIEW && task.state !== TaskState.COMPLETED) {
    // Supervisor stopped but task not in review - likely needs attention
    console.log(
      `Supervisor ${agentId}: Task ${task.id} is in state ${task.state}, may need manual attention`
    );
  }
}

/**
 * Check supervisor inbox for worker messages and task status
 * Only notifies about NEW items to avoid spamming
 */
async function checkSupervisorInbox(agentId: string): Promise<void> {
  const supervisorContext = activeSupervisors.get(agentId);
  if (!supervisorContext?.isRunning) {
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

      agentProcessAdapter.sendToAgent(
        agentId,
        `You have ${newMail.length} new message(s) in your inbox:\n${mailSummary}\n\nUse mcp__mail__read to read them.`
      );
    }

    // Also check task status and prompt supervisor if there are tasks ready for review
    const tasks = await taskAccessor.list({ parentId: supervisorContext.topLevelTaskId });
    const reviewTasks = tasks.filter((t) => t.state === 'REVIEW');
    const completedTasks = tasks.filter((t) => t.state === 'COMPLETED');
    const failedTasks = tasks.filter((t) => t.state === 'FAILED');
    const inProgressTasks = tasks.filter((t) => t.state === 'IN_PROGRESS');

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

      agentProcessAdapter.sendToAgent(
        agentId,
        `NEW TASKS READY FOR REVIEW:\n` +
          `${newReviewTasks.map((t) => `- ${t.title} (${t.id})`).join('\n')}\n\n` +
          `Total status: ${reviewTasks.length} in review, ${inProgressTasks.length} in progress, ${completedTasks.length} completed, ${failedTasks.length} failed\n\n` +
          `Use mcp__task__get_review_queue to see the full review queue.`
      );
    }
    // If all tasks are done and we haven't notified yet, prompt to create final PR
    else if (tasks.length > 0 && inProgressTasks.length === 0 && reviewTasks.length === 0) {
      const allDone = completedTasks.length + failedTasks.length === tasks.length;
      if (allDone && !supervisorContext.lastNotifiedAllComplete) {
        supervisorContext.lastNotifiedAllComplete = true;
        console.log(`Supervisor ${agentId}: All tasks complete, prompting for final PR`);
        agentProcessAdapter.sendToAgent(
          agentId,
          `ALL TASKS COMPLETE!\n` +
            `- ${completedTasks.length} task(s) completed successfully\n` +
            `- ${failedTasks.length} task(s) failed\n\n` +
            `It's time to create the final PR from the top-level task branch to main.\n` +
            `Use mcp__task__create_final_pr to create the final PR.`
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
  if (!supervisorContext?.isRunning) {
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
          agentProcessAdapter.sendToAgent(
            agentId,
            `[AUTOMATIC WORKER HEALTH CHECK] Worker permanently failed:\n` +
              `- Task ID: ${unhealthy.taskId}\n` +
              `- Old Worker: ${unhealthy.workerId}\n` +
              `- Reason: Max recovery attempts (${result.attemptNumber}) reached\n\n` +
              `The task has been marked as FAILED. You may need to manually investigate or mark it complete using mcp__task__force_complete.`
          );
        } else if (result.success) {
          agentProcessAdapter.sendToAgent(
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
 * Stop a running supervisor agent gracefully
 */
export async function stopSupervisor(agentId: string): Promise<void> {
  const supervisorContext = activeSupervisors.get(agentId);
  if (!supervisorContext) {
    throw new Error(`Supervisor ${agentId} is not running`);
  }

  console.log(`Stopping supervisor ${agentId}`);

  // Clean up context
  cleanupSupervisorContext(agentId);

  // Stop the Claude process gracefully
  await agentProcessAdapter.stopAgent(agentId);

  // Update agent state
  await agentAccessor.update(agentId, {
    executionState: ExecutionState.IDLE,
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

  // Force kill the Claude process
  agentProcessAdapter.killAgent(agentId);

  // Delete worktree if task exists
  if (agent.currentTaskId) {
    const topLevelTask = await taskAccessor.findById(agent.currentTaskId);
    if (topLevelTask?.project) {
      const gitClient = GitClientFactory.forProject({
        repoPath: topLevelTask.project.repoPath,
        worktreeBasePath: topLevelTask.project.worktreeBasePath,
      });
      const worktreeName = getTopLevelTaskWorktreeName(agent.currentTaskId);
      try {
        await gitClient.deleteWorktree(worktreeName);
      } catch {
        // Worktree may not exist
      }
    }
  }

  // Clean up system prompt file
  promptFileManager.deletePromptFile(agentId);

  // Remove from active supervisors
  activeSupervisors.delete(agentId);

  // Clean up prompt cache if exists
  supervisorPromptCache.delete(agentId);

  console.log(`Supervisor ${agentId} killed and cleaned up`);
}

/**
 * Check if a supervisor is running
 */
export function isSupervisorRunning(agentId: string): boolean {
  const supervisorContext = activeSupervisors.get(agentId);
  return supervisorContext?.isRunning ?? false;
}
