import { AgentType, DesiredExecutionState, ExecutionState, TaskState } from '@prisma-gen/client';
import { GitClientFactory } from '../../clients/git.client.js';
import {
  agentAccessor,
  mailAccessor,
  projectAccessor,
  taskAccessor,
} from '../../resource_accessors/index.js';
import { type AgentProcessEvents, agentProcessAdapter } from '../process-adapter.js';
import { buildWorkerPrompt } from '../prompts/builders/worker.builder.js';

/**
 * Worker agent context - tracks running workers
 */
interface WorkerContext {
  agentId: string;
  taskId: string;
  isRunning: boolean;
  inboxCheckInterval?: NodeJS.Timeout;
  eventCleanup?: () => void;
}

// In-memory store for active workers
const activeWorkers = new Map<string, WorkerContext>();

// Cache for worker prompts (used between createWorker and runWorker)
const workerPromptCache = new Map<
  string,
  {
    systemPrompt: string;
    workingDir: string;
    resumeSessionId?: string;
  }
>();

export interface CreateWorkerOptions {
  /** If provided, resume an existing Claude session instead of starting fresh */
  resumeSessionId?: string;
}

/**
 * Create a new worker agent for a task
 * If resumeSessionId is provided, the Claude session will resume with conversation history
 */
export async function createWorker(taskId: string, options?: CreateWorkerOptions): Promise<string> {
  // Get task
  const task = await taskAccessor.findById(taskId);
  if (!task) {
    throw new Error(`Task with ID '${taskId}' not found`);
  }

  if (!task.parentId) {
    throw new Error(`Task '${taskId}' does not have a parent task`);
  }

  // Get the top-level task (root of the hierarchy) - this is what supervisors manage
  const topLevelTask = await taskAccessor.getTopLevelParent(taskId);
  if (!topLevelTask) {
    throw new Error(`Could not find top-level task for task '${taskId}'`);
  }

  // Get project for this task using projectId
  const project = await projectAccessor.findById(topLevelTask.projectId);
  if (!project) {
    throw new Error(`Project with ID '${topLevelTask.projectId}' not found`);
  }

  // Build top-level task branch name (matches supervisor's branch naming convention)
  // Workers should branch from the top-level task branch so they have the latest merged code
  const topLevelBranchName = `factoryfactory/task-${topLevelTask.id.substring(0, 8)}`;

  // Create agent record
  const agent = await agentAccessor.create({
    type: AgentType.WORKER,
    executionState: ExecutionState.IDLE,
    desiredExecutionState: DesiredExecutionState.IDLE,
    currentTaskId: taskId,
  });

  // Get project-specific GitClient
  const gitClient = GitClientFactory.forProject({
    repoPath: project.repoPath,
    worktreeBasePath: project.worktreeBasePath,
  });

  // Create git worktree for task (branching from epic branch, not main)
  const worktreeName = `task-${agent.id.substring(0, 8)}`;
  const worktreeInfo = await gitClient.createWorktree(worktreeName, topLevelBranchName);

  // Update task with branch info (worktreePath is stored on agent)
  await taskAccessor.update(taskId, {
    assignedAgentId: agent.id,
    branchName: worktreeInfo.branchName,
    state: TaskState.IN_PROGRESS,
  });

  // Backend URL for API calls
  const backendUrl = `http://localhost:${process.env.BACKEND_PORT || 3001}`;

  // Find the supervisor for the top-level task
  const supervisor = await agentAccessor.findByTopLevelTaskId(topLevelTask.id);
  if (!supervisor) {
    throw new Error(`No supervisor found for top-level task ${topLevelTask.id}`);
  }

  // Build system prompt with full context
  const systemPrompt = buildWorkerPrompt({
    taskId: task.id,
    taskTitle: task.title,
    taskDescription: task.description || 'No description provided',
    parentTaskTitle: topLevelTask.title,
    parentTaskBranchName: topLevelBranchName,
    worktreePath: worktreeInfo.path,
    branchName: worktreeInfo.branchName,
    agentId: agent.id,
    backendUrl,
    supervisorAgentId: supervisor.id,
  });

  // Update agent with worktree path and session info (if resuming)
  await agentAccessor.update(agent.id, {
    worktreePath: worktreeInfo.path,
    ...(options?.resumeSessionId && { sessionId: options.resumeSessionId }),
  });

  // Store prompt for use when starting the agent
  // The adapter will use this when startAgent is called
  workerPromptCache.set(agent.id, {
    systemPrompt,
    workingDir: worktreeInfo.path,
    resumeSessionId: options?.resumeSessionId,
  });

  console.log(`Created worker ${agent.id} for task ${taskId}`);
  console.log(`Worktree: ${worktreeInfo.path}`);

  return agent.id;
}

/**
 * Run a worker agent - starts the Claude process and sets up event handlers
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

  // Check if already running
  if (activeWorkers.has(agentId)) {
    throw new Error(`Worker ${agentId} is already running`);
  }

  // Get cached prompt info
  const promptInfo = workerPromptCache.get(agentId);
  if (!promptInfo) {
    throw new Error(`No prompt info found for agent ${agentId}. Was createWorker called?`);
  }

  // Get task
  const task = await taskAccessor.findById(agent.currentTaskId);
  if (!task) {
    throw new Error(`Task with ID '${agent.currentTaskId}' not found`);
  }

  // Create worker context
  const workerContext: WorkerContext = {
    agentId,
    taskId: task.id,
    isRunning: true,
  };
  activeWorkers.set(agentId, workerContext);

  // Update agent state
  await agentAccessor.update(agentId, {
    executionState: ExecutionState.ACTIVE,
  });

  console.log(`Starting worker ${agentId}`);

  // Set up event handlers for the adapter
  const handleMessage = (event: AgentProcessEvents['message']) => {
    if (event.agentId !== agentId) {
      return;
    }

    const msg = event.message;

    // Log messages for debugging based on type
    switch (msg.type) {
      case 'assistant':
        console.log(`Worker ${agentId}: Assistant message received`);
        break;
      case 'tool_use':
        console.log(`Worker ${agentId}: Tool use - ${'tool' in msg ? msg.tool : 'unknown'}`);
        break;
      case 'tool_result':
        console.log(
          `Worker ${agentId}: Tool result - ${'is_error' in msg && msg.is_error ? 'error' : 'success'}`
        );
        break;
    }
  };

  const handleResult = async (event: AgentProcessEvents['result']) => {
    if (event.agentId !== agentId) {
      return;
    }

    console.log(`Worker ${agentId}: Session completed`);
    console.log(`  Claude Session ID: ${event.claudeSessionId}`);
    console.log(`  Turns: ${event.numTurns}`);
    console.log(`  Duration: ${event.durationMs}ms`);
    console.log(`  Cost: $${event.totalCostUsd?.toFixed(4) || 'N/A'}`);

    // Store Claude session ID for potential resume
    await agentAccessor.update(agentId, {
      sessionId: event.claudeSessionId,
    });

    // Handle completion
    await handleWorkerCompletion(agentId, 'Claude session completed');
  };

  const handleError = (event: AgentProcessEvents['error']) => {
    if (event.agentId !== agentId) {
      return;
    }

    console.error(`Worker ${agentId}: Error - ${event.error.message}`);

    // Don't stop the worker on errors - adapter handles recovery
  };

  const handleExit = async (event: AgentProcessEvents['exit']) => {
    if (event.agentId !== agentId) {
      return;
    }

    console.log(`Worker ${agentId}: Process exited with code ${event.code}`);

    if (event.sessionId) {
      // Store session ID for potential resume
      await agentAccessor.update(agentId, {
        sessionId: event.sessionId,
      });
    }

    // Handle completion based on exit code
    const reason =
      event.code === 0 ? 'Process exited normally' : `Process exited with code ${event.code}`;
    await handleWorkerCompletion(agentId, reason);
  };

  // Register event handlers
  agentProcessAdapter.on('message', handleMessage);
  agentProcessAdapter.on('result', handleResult);
  agentProcessAdapter.on('error', handleError);
  agentProcessAdapter.on('exit', handleExit);

  // Store cleanup function
  workerContext.eventCleanup = () => {
    agentProcessAdapter.off('message', handleMessage);
    agentProcessAdapter.off('result', handleResult);
    agentProcessAdapter.off('error', handleError);
    agentProcessAdapter.off('exit', handleExit);
  };

  // Start inbox check timer for supervisor messages (rebase requests, etc.)
  workerContext.inboxCheckInterval = setInterval(async () => {
    await checkWorkerInbox(agentId);
  }, 10_000); // Check every 10 seconds

  // Start the Claude process via the adapter
  try {
    const model = process.env.WORKER_MODEL || 'claude-sonnet-4-5-20250929';
    const initialPrompt = 'Check your task assignment and begin work.';

    await agentProcessAdapter.startAgent({
      agentId,
      agentType: 'worker',
      workingDir: promptInfo.workingDir,
      systemPrompt: promptInfo.systemPrompt,
      initialPrompt,
      model,
      resumeSessionId: promptInfo.resumeSessionId,
    });

    console.log(`Worker ${agentId} is now running`);

    // Clean up prompt cache after starting
    workerPromptCache.delete(agentId);
  } catch (error) {
    // Clean up on startup failure
    cleanupWorkerContext(agentId);
    throw error;
  }
}

/**
 * Handle a rebase request mail
 */
async function handleRebaseRequest(
  agentId: string,
  mail: { id: string; body: string },
  taskId: string
): Promise<void> {
  console.log(`Worker ${agentId}: Received rebase request`);
  await mailAccessor.markAsRead(mail.id);

  const task = await taskAccessor.findById(taskId);
  if (!task) {
    return;
  }

  const message = `REBASE REQUIRED\n\n${mail.body}\n\nPlease:\n1. Run 'git fetch origin' to get latest changes\n2. Run 'git rebase origin/<top-level-branch-name>' to rebase your branch\n3. Resolve any conflicts if needed\n4. Force push with 'git push --force'\n5. Your PR will be automatically updated\n\nAfter rebasing, your PR will return to the review queue.`;

  agentProcessAdapter.sendToAgent(agentId, message);

  if (task.state === TaskState.BLOCKED) {
    await taskAccessor.update(task.id, { state: TaskState.IN_PROGRESS });
  }
}

/**
 * Handle a change request mail
 */
async function handleChangesRequested(
  agentId: string,
  mail: { id: string; body: string }
): Promise<void> {
  console.log(`Worker ${agentId}: Received change request`);
  await mailAccessor.markAsRead(mail.id);

  const message = `CHANGES REQUESTED\n\n${mail.body}\n\nPlease address the feedback above, then commit and push your changes. The PR will be re-reviewed once you're done.`;

  agentProcessAdapter.sendToAgent(agentId, message);
}

/**
 * Handle a generic mail
 */
async function handleGenericMail(
  agentId: string,
  mail: { id: string; subject: string; body: string; fromAgentId: string | null }
): Promise<void> {
  await mailAccessor.markAsRead(mail.id);

  const message = `New Message from ${mail.fromAgentId || 'supervisor'}:\n\nSubject: ${mail.subject}\n\n${mail.body}`;

  agentProcessAdapter.sendToAgent(agentId, message);
}

/**
 * Check worker inbox for supervisor messages (like rebase requests)
 */
async function checkWorkerInbox(agentId: string): Promise<void> {
  const workerContext = activeWorkers.get(agentId);
  if (!workerContext?.isRunning) {
    return;
  }

  try {
    const inbox = await mailAccessor.listInbox(agentId, false);
    if (inbox.length === 0) {
      return;
    }

    console.log(`Worker ${agentId}: Found ${inbox.length} unread mail(s)`);

    for (const mail of inbox) {
      if (mail.subject === 'Rebase Required') {
        await handleRebaseRequest(agentId, mail, workerContext.taskId);
      } else if (mail.subject === 'Changes Requested') {
        await handleChangesRequested(agentId, mail);
      } else {
        await handleGenericMail(agentId, mail);
      }
    }
  } catch (error) {
    console.error(`Worker ${agentId}: Inbox check error:`, error);
  }
}

/**
 * Clean up worker context (intervals and event handlers)
 */
function cleanupWorkerContext(agentId: string): void {
  const workerContext = activeWorkers.get(agentId);
  if (!workerContext) {
    return;
  }

  // Clear inbox check interval
  if (workerContext.inboxCheckInterval) {
    clearInterval(workerContext.inboxCheckInterval);
  }

  // Clean up event handlers
  if (workerContext.eventCleanup) {
    workerContext.eventCleanup();
  }

  workerContext.isRunning = false;
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

  // Clean up context
  cleanupWorkerContext(agentId);

  // Update agent state
  await agentAccessor.update(agentId, {
    executionState: ExecutionState.IDLE,
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

  // Clean up context
  cleanupWorkerContext(agentId);

  // Stop the Claude process gracefully
  await agentProcessAdapter.stopAgent(agentId);

  // Update agent state
  await agentAccessor.update(agentId, {
    executionState: ExecutionState.IDLE,
  });

  console.log(`Worker ${agentId} stopped`);
}

/**
 * Clean up worktree for an agent if it exists
 */
async function cleanupAgentWorktree(agentId: string): Promise<void> {
  const agent = await agentAccessor.findById(agentId);
  if (!agent?.worktreePath) {
    return;
  }

  // Get task to find the project
  if (!agent.currentTaskId) {
    return;
  }

  const task = await taskAccessor.findById(agent.currentTaskId);
  if (!task?.parentId) {
    return;
  }

  const parentTask = await taskAccessor.findById(task.parentId);
  if (!parentTask?.project) {
    return;
  }

  const gitClient = GitClientFactory.forProject({
    repoPath: parentTask.project.repoPath,
    worktreeBasePath: parentTask.project.worktreeBasePath,
  });

  const worktreeName = agent.worktreePath.split('/').pop();
  if (worktreeName) {
    try {
      await gitClient.deleteWorktree(worktreeName);
    } catch {
      // Worktree may not exist
    }
  }
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

  // Force kill the Claude process
  await agentProcessAdapter.killAgent(agentId);

  // Delete worktree for this agent
  await cleanupAgentWorktree(agentId);

  // Remove from active workers
  activeWorkers.delete(agentId);

  // Clean up prompt cache if exists
  workerPromptCache.delete(agentId);

  console.log(`Worker ${agentId} killed and cleaned up`);
}

/**
 * Check if a worker is running
 */
export function isWorkerRunning(agentId: string): boolean {
  const workerContext = activeWorkers.get(agentId);
  return workerContext?.isRunning ?? false;
}
