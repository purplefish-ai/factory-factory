import { AgentType, TaskState } from '@prisma-gen/client';
import { z } from 'zod';
import { startWorker } from '../../agents/worker/lifecycle.js';
import { type GitClient, GitClientFactory } from '../../clients/git.client.js';
import type { PRInfo, PRStatus } from '../../clients/github.client.js';
import { githubClient } from '../../clients/index.js';
import { inngest } from '../../inngest/client.js';
import {
  agentAccessor,
  decisionLogAccessor,
  mailAccessor,
  taskAccessor,
} from '../../resource_accessors/index.js';
import { notificationService } from '../../services/notification.service.js';
import { createErrorResponse, createSuccessResponse, registerMcpTool } from './server.js';
import type { McpToolContext, McpToolResponse } from './types.js';
import { McpErrorCode } from './types.js';

// ============================================================================
// Input Schemas
// ============================================================================

const UpdateStateInputSchema = z.object({
  state: z.nativeEnum(TaskState),
  failureReason: z.string().optional(),
});

const CreatePRInputSchema = z.object({
  title: z.string(),
  description: z.string(),
});

const GetPRStatusInputSchema = z.object({});

const CreateTaskInputSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().min(1, 'Description is required'),
});

const ListTasksInputSchema = z.object({
  state: z.nativeEnum(TaskState).optional(),
});

const GetReviewQueueInputSchema = z.object({});

const ApproveTaskInputSchema = z.object({
  taskId: z.string().min(1, 'Task ID is required'),
});

const RequestChangesInputSchema = z.object({
  taskId: z.string().min(1, 'Task ID is required'),
  feedback: z.string().min(1, 'Feedback is required'),
});

const CreateFinalPRInputSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
});

const ForceCompleteTaskInputSchema = z.object({
  taskId: z.string().min(1, 'Task ID is required'),
  reason: z.string().min(1, 'Reason for manual completion is required'),
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate state transition is allowed
 */
function isValidStateTransition(from: TaskState, to: TaskState): boolean {
  const validTransitions: Record<TaskState, TaskState[]> = {
    [TaskState.PLANNING]: [TaskState.PLANNED, TaskState.CANCELLED],
    [TaskState.PLANNED]: [TaskState.IN_PROGRESS, TaskState.CANCELLED],
    [TaskState.PENDING]: [TaskState.ASSIGNED, TaskState.IN_PROGRESS, TaskState.BLOCKED],
    [TaskState.ASSIGNED]: [TaskState.IN_PROGRESS, TaskState.PENDING],
    [TaskState.IN_PROGRESS]: [TaskState.REVIEW, TaskState.BLOCKED, TaskState.FAILED],
    [TaskState.REVIEW]: [TaskState.COMPLETED, TaskState.IN_PROGRESS, TaskState.BLOCKED],
    [TaskState.BLOCKED]: [TaskState.IN_PROGRESS, TaskState.FAILED, TaskState.PENDING],
    [TaskState.COMPLETED]: [],
    [TaskState.FAILED]: [TaskState.IN_PROGRESS, TaskState.PENDING],
    [TaskState.CANCELLED]: [],
  };

  return validTransitions[from]?.includes(to) ?? false;
}

/**
 * Verify agent is a SUPERVISOR with a top-level task assigned
 */
async function verifySupervisorWithTopLevelTask(
  context: McpToolContext
): Promise<
  | { success: true; agentId: string; topLevelTaskId: string }
  | { success: false; error: McpToolResponse }
> {
  const agent = await agentAccessor.findById(context.agentId);
  if (!agent) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.AGENT_NOT_FOUND,
        `Agent with ID '${context.agentId}' not found`
      ),
    };
  }

  if (agent.type !== AgentType.SUPERVISOR) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.PERMISSION_DENIED,
        'Only SUPERVISOR agents can use these task management tools'
      ),
    };
  }

  if (!agent.currentTaskId) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Supervisor does not have a top-level task assigned'
      ),
    };
  }

  return { success: true, agentId: agent.id, topLevelTaskId: agent.currentTaskId };
}

/**
 * Generate worktree name for a task
 */
function generateWorktreeName(taskId: string, title: string): string {
  const sanitizedTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .substring(0, 30)
    .replace(/-+$/, '');
  return `task-${taskId.substring(0, 8)}-${sanitizedTitle}`;
}

/**
 * Send rebase requests to other workers in review
 */
async function sendRebaseRequests(
  context: McpToolContext,
  topLevelTaskId: string,
  excludeTaskId: string,
  topLevelBranchName: string
): Promise<number> {
  const otherReviewTasks = await taskAccessor.getReviewQueue(topLevelTaskId);
  let count = 0;

  for (const reviewTask of otherReviewTasks) {
    if (reviewTask.id !== excludeTaskId && reviewTask.assignedAgentId) {
      await taskAccessor.update(reviewTask.id, { state: TaskState.BLOCKED });
      await mailAccessor.create({
        fromAgentId: context.agentId,
        toAgentId: reviewTask.assignedAgentId,
        subject: 'Rebase Required',
        body: `Another task has been merged into the top-level task branch. Please rebase your branch against the top-level task branch before I can review your code.\n\nTask: ${reviewTask.title}\nTop-level branch: ${topLevelBranchName}\n\nRun: git fetch origin && git rebase origin/${topLevelBranchName}`,
      });
      count++;
    }
  }

  return count;
}

/**
 * Clean up worker after task completion
 */
async function cleanupWorker(agentId: string | null): Promise<boolean> {
  if (!agentId) {
    return false;
  }

  try {
    const { killWorkerAndCleanup } = await import('../../agents/worker/lifecycle.js');
    await killWorkerAndCleanup(agentId);
    console.log(`Cleaned up worker ${agentId} after task approval`);
    return true;
  } catch (error) {
    console.log(
      `Note: Could not clean up worker ${agentId}: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

interface TaskForApproval {
  id: string;
  title: string;
  branchName: string;
  assignedAgentId: string | null;
}

interface TopLevelTaskForApproval {
  id: string;
  topLevelTaskId: string;
  topLevelWorktreePath: string;
  gitClient: GitClient;
}

/**
 * Validate task is ready for approval
 */
async function validateTaskForApproval(
  taskId: string,
  topLevelTaskId: string
): Promise<{ success: true; task: TaskForApproval } | { success: false; error: McpToolResponse }> {
  const task = await taskAccessor.findById(taskId);
  if (!task) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Task with ID '${taskId}' not found`
      ),
    };
  }
  if (task.parentId !== topLevelTaskId) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.PERMISSION_DENIED,
        'Task does not belong to this top-level task'
      ),
    };
  }
  if (task.state !== TaskState.REVIEW) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        `Task is in state ${task.state}, expected REVIEW`
      ),
    };
  }
  if (!task.branchName) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Task does not have a branch name'
      ),
    };
  }
  return {
    success: true,
    task: {
      id: task.id,
      title: task.title,
      branchName: task.branchName,
      assignedAgentId: task.assignedAgentId,
    },
  };
}

/**
 * Get top-level task and worktree path for approval
 */
async function getTopLevelTaskForApproval(
  topLevelTaskId: string
): Promise<
  | { success: true; topLevelTask: TopLevelTaskForApproval }
  | { success: false; error: McpToolResponse }
> {
  const topLevelTask = await taskAccessor.findById(topLevelTaskId);
  if (!topLevelTask) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Top-level task with ID '${topLevelTaskId}' not found`
      ),
    };
  }

  // Get project for this task
  const project = topLevelTask.project;
  if (!project) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        `Top-level task '${topLevelTaskId}' does not have an associated project`
      ),
    };
  }

  // Get project-specific GitClient
  const gitClient = GitClientFactory.forProject({
    repoPath: project.repoPath,
    worktreeBasePath: project.worktreeBasePath,
  });

  const topLevelWorktreeName = `epic-${topLevelTask.id.substring(0, 8)}`;
  return {
    success: true,
    topLevelTask: {
      id: topLevelTask.id,
      topLevelTaskId,
      topLevelWorktreePath: gitClient.getWorktreePath(topLevelWorktreeName),
      gitClient,
    },
  };
}

/**
 * Merge a task branch into the top-level task worktree
 */
async function mergeTaskBranch(
  gitClient: GitClient,
  topLevelWorktreePath: string,
  branchName: string,
  taskTitle: string
): Promise<{ success: true; mergeCommit: string } | { success: false; error: McpToolResponse }> {
  try {
    const result = await gitClient.mergeBranch(
      topLevelWorktreePath,
      branchName,
      `Merge task: ${taskTitle}`
    );
    return { success: true, mergeCommit: result.mergeCommit };
  } catch (error) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.INTERNAL_ERROR,
        `Failed to merge branch ${branchName}: ${error instanceof Error ? error.message : String(error)}`
      ),
    };
  }
}

/**
 * Try to push the top-level task branch, returns whether push succeeded
 */
async function tryPushTopLevelBranch(
  gitClient: GitClient,
  topLevelWorktreePath: string
): Promise<boolean> {
  try {
    await gitClient.pushBranchWithUpstream(topLevelWorktreePath);
    return true;
  } catch (error) {
    console.log(
      `Note: Could not push top-level branch (this is OK for local testing): ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Build the approval result message
 */
function buildApprovalMessage(
  pushed: boolean,
  rebaseRequestsSent: number,
  workerCleanedUp: boolean
): string {
  const pushStatus = pushed
    ? 'merged into top-level task and pushed'
    : 'merged into top-level task locally (push skipped - no remote)';
  const workerStatus = workerCleanedUp ? ' Worker cleaned up.' : '';
  return `Task approved. Branch ${pushStatus}. ${rebaseRequestsSent} rebase requests sent.${workerStatus}`;
}

/**
 * Generate PR description for top-level task completion
 */
function generateTopLevelPRDescription(
  topLevelTask: { title: string; description: string | null },
  completedTasks: { title: string }[],
  failedTasks: { title: string; failureReason: string | null }[]
): string {
  const failedSection =
    failedTasks.length > 0
      ? `## Failed Tasks (${failedTasks.length})\n${failedTasks.map((t) => `- [x] ${t.title}: ${t.failureReason || 'No reason'}`).join('\n')}`
      : '';

  return `## Task: ${topLevelTask.title}

${topLevelTask.description || 'No description provided.'}

## Completed Subtasks (${completedTasks.length})
${completedTasks.map((t) => `- [x] ${t.title}`).join('\n')}

${failedSection}

---
*This PR was created by the FactoryFactory Supervisor agent.*`;
}

/**
 * Cleanup workers for all tasks
 */
async function cleanupAllWorkers(tasks: { assignedAgentId: string | null }[]): Promise<number> {
  const { killWorkerAndCleanup } = await import('../../agents/worker/lifecycle.js');
  let count = 0;

  for (const task of tasks) {
    if (task.assignedAgentId) {
      try {
        await killWorkerAndCleanup(task.assignedAgentId);
        count++;
      } catch (error) {
        console.log(
          `Note: Could not clean up worker ${task.assignedAgentId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  console.log(`Cleaned up ${count} worker session(s)`);
  return count;
}

/**
 * Attempt to create PR on GitHub
 */
async function attemptCreatePR(
  branchName: string,
  title: string,
  description: string,
  worktreePath: string
): Promise<{ prInfo: { url: string; number: number } | null; created: boolean }> {
  try {
    const prInfo = await githubClient.createPR(
      branchName,
      'main',
      title,
      description,
      worktreePath
    );
    return { prInfo, created: true };
  } catch (error) {
    console.log(
      `Note: Could not create PR (this is OK for local testing): ${error instanceof Error ? error.message : String(error)}`
    );
    return { prInfo: null, created: false };
  }
}

/**
 * Send notifications after top-level task completion
 */
async function sendTopLevelCompletionNotifications(
  context: McpToolContext,
  topLevelTask: { id: string; title: string },
  prUrl: string | null
): Promise<void> {
  try {
    await notificationService.notifyEpicComplete(topLevelTask.title, prUrl || undefined);
  } catch (error) {
    console.error('Failed to send top-level task completion notification:', error);
  }

  try {
    await inngest.send({
      name: 'agent.completed',
      data: { agentId: context.agentId, taskId: topLevelTask.id },
    });
  } catch (error) {
    console.log(
      'Inngest event send failed (this is OK if Inngest dev server is not running):',
      error
    );
  }
}

/**
 * Generate completion mail body for top-level task PR
 */
function generateTopLevelCompletionMailBody(
  topLevelTaskTitle: string,
  branchName: string,
  completedCount: number,
  failedCount: number,
  prUrl: string | undefined,
  prCreated: boolean
): string {
  const taskSummary = `Completed tasks: ${completedCount}\nFailed tasks: ${failedCount}`;
  if (prCreated) {
    return `The top-level task "${topLevelTaskTitle}" has been completed and is ready for review.\n\nPR URL: ${prUrl}\nBranch: ${branchName}\n\n${taskSummary}`;
  }
  return `The top-level task "${topLevelTaskTitle}" has been completed locally.\n\nNote: PR could not be created (no remote configured).\nBranch: ${branchName}\n\n${taskSummary}`;
}

interface WorkerTaskContext {
  agentId: string;
  task: {
    id: string;
    parentId: string | null;
    branchName: string;
    worktreePath: string;
    title: string;
  };
  topLevelTask: { id: string };
}

/**
 * Validate worker context for PR creation
 */
async function validateWorkerForPR(
  context: McpToolContext
): Promise<
  { success: true; data: WorkerTaskContext } | { success: false; error: McpToolResponse }
> {
  const agent = await agentAccessor.findById(context.agentId);
  if (!agent) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.AGENT_NOT_FOUND,
        `Agent with ID '${context.agentId}' not found`
      ),
    };
  }

  if (agent.type !== AgentType.WORKER) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.PERMISSION_DENIED,
        'Only WORKER agents can create pull requests'
      ),
    };
  }

  if (!agent.currentTaskId) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Agent does not have a current task assigned'
      ),
    };
  }

  const task = await taskAccessor.findById(agent.currentTaskId);
  if (!task) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Task with ID '${agent.currentTaskId}' not found`
      ),
    };
  }

  // Get the top-level parent task (what was formerly "Epic")
  const topLevelTask = await taskAccessor.getTopLevelParent(task.id);
  if (!topLevelTask) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Top-level task for task '${task.id}' not found`
      ),
    };
  }

  if (!task.branchName) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Task does not have a branch name'
      ),
    };
  }

  if (!task.worktreePath) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Task does not have a worktree path'
      ),
    };
  }

  return {
    success: true,
    data: {
      agentId: agent.id,
      task: {
        id: task.id,
        parentId: task.parentId,
        branchName: task.branchName,
        worktreePath: task.worktreePath,
        title: task.title,
      },
      topLevelTask: { id: topLevelTask.id },
    },
  };
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Update task state (WORKER only)
 */
async function updateState(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const validatedInput = UpdateStateInputSchema.parse(input);

    // Get agent
    const agent = await agentAccessor.findById(context.agentId);
    if (!agent) {
      return createErrorResponse(
        McpErrorCode.AGENT_NOT_FOUND,
        `Agent with ID '${context.agentId}' not found`
      );
    }

    // Verify agent is WORKER
    if (agent.type !== AgentType.WORKER) {
      return createErrorResponse(
        McpErrorCode.PERMISSION_DENIED,
        'Only WORKER agents can update task state'
      );
    }

    // Verify agent has a task
    if (!agent.currentTaskId) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Agent does not have a current task assigned'
      );
    }

    // Get task
    const task = await taskAccessor.findById(agent.currentTaskId);
    if (!task) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Task with ID '${agent.currentTaskId}' not found`
      );
    }

    // Validate state transition
    if (!isValidStateTransition(task.state, validatedInput.state)) {
      return createErrorResponse(
        McpErrorCode.INVALID_INPUT,
        `Invalid state transition from ${task.state} to ${validatedInput.state}`
      );
    }

    // Update task
    const updatedTask = await taskAccessor.update(task.id, {
      state: validatedInput.state,
      failureReason: validatedInput.failureReason,
      completedAt:
        validatedInput.state === TaskState.COMPLETED || validatedInput.state === TaskState.FAILED
          ? new Date()
          : null,
    });

    // Log decision
    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__task__update_state',
      'result',
      {
        taskId: task.id,
        oldState: task.state,
        newState: validatedInput.state,
        failureReason: validatedInput.failureReason,
      }
    );

    return createSuccessResponse({
      taskId: updatedTask.id,
      state: updatedTask.state,
      updatedAt: updatedTask.updatedAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

/**
 * Create pull request for task (WORKER only)
 */
async function createPR(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const validatedInput = CreatePRInputSchema.parse(input);

    const validation = await validateWorkerForPR(context);
    if (!validation.success) {
      return validation.error;
    }
    const { task, topLevelTask, agentId } = validation.data;

    // Branch targets the top-level task's branch (what was formerly "epic branch")
    const topLevelBranchName = `factoryfactory/task-${topLevelTask.id}`;

    let prInfo: PRInfo;
    try {
      prInfo = await githubClient.createPR(
        task.branchName,
        topLevelBranchName,
        validatedInput.title,
        validatedInput.description,
        task.worktreePath
      );
    } catch (error) {
      return createErrorResponse(
        McpErrorCode.INTERNAL_ERROR,
        `Failed to create PR: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const updatedTask = await taskAccessor.update(task.id, {
      prUrl: prInfo.url,
      state: TaskState.REVIEW,
    });

    // Find the supervisor for the top-level task
    const supervisor = await agentAccessor.findSupervisorByTopLevelTaskId(topLevelTask.id);
    if (supervisor) {
      await mailAccessor.create({
        fromAgentId: agentId,
        toAgentId: supervisor.id,
        subject: `Task Complete: ${task.title}`,
        body: `Task ${task.id} has been completed and PR ${prInfo.url} has been created for review.`,
      });
    }

    await decisionLogAccessor.createAutomatic(context.agentId, 'mcp__task__create_pr', 'result', {
      taskId: task.id,
      prUrl: prInfo.url,
      prNumber: prInfo.number,
    });

    notificationService
      .notifyTaskComplete(task.title, prInfo.url, task.branchName)
      .catch((error) => {
        console.error('Failed to send task completion notification:', error);
      });

    return createSuccessResponse({
      taskId: updatedTask.id,
      prUrl: prInfo.url,
      prNumber: prInfo.number,
      state: updatedTask.state,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

/**
 * Get PR status for task (WORKER only)
 */
async function getPRStatus(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    GetPRStatusInputSchema.parse(input);

    // Get agent
    const agent = await agentAccessor.findById(context.agentId);
    if (!agent) {
      return createErrorResponse(
        McpErrorCode.AGENT_NOT_FOUND,
        `Agent with ID '${context.agentId}' not found`
      );
    }

    // Verify agent is WORKER
    if (agent.type !== AgentType.WORKER) {
      return createErrorResponse(
        McpErrorCode.PERMISSION_DENIED,
        'Only WORKER agents can get PR status'
      );
    }

    // Verify agent has a task
    if (!agent.currentTaskId) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Agent does not have a current task assigned'
      );
    }

    // Get task
    const task = await taskAccessor.findById(agent.currentTaskId);
    if (!task) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Task with ID '${agent.currentTaskId}' not found`
      );
    }

    // Verify task has PR
    if (!task.prUrl) {
      return createErrorResponse(McpErrorCode.INVALID_AGENT_STATE, 'Task does not have a PR URL');
    }

    // Get PR status
    let prStatus: PRStatus;
    try {
      prStatus = await githubClient.getPRStatus(task.prUrl, task.worktreePath || undefined);
    } catch (error) {
      return createErrorResponse(
        McpErrorCode.INTERNAL_ERROR,
        `Failed to get PR status: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Log decision
    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__task__get_pr_status',
      'result',
      {
        taskId: task.id,
        prUrl: task.prUrl,
        prStatus,
      }
    );

    return createSuccessResponse({
      taskId: task.id,
      prUrl: task.prUrl,
      state: prStatus.state,
      isDraft: prStatus.isDraft,
      mergeable: prStatus.mergeable,
      reviewDecision: prStatus.reviewDecision,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

/**
 * Create a new subtask for the top-level task (SUPERVISOR only)
 */
async function createTask(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const validatedInput = CreateTaskInputSchema.parse(input);

    // Verify supervisor has top-level task
    const verification = await verifySupervisorWithTopLevelTask(context);
    if (!verification.success) {
      return verification.error;
    }

    // Get top-level task
    const topLevelTask = await taskAccessor.findById(verification.topLevelTaskId);
    if (!topLevelTask) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Top-level task with ID '${verification.topLevelTaskId}' not found`
      );
    }

    // Create subtask
    const task = await taskAccessor.create({
      projectId: topLevelTask.projectId,
      parentId: topLevelTask.id,
      title: validatedInput.title,
      description: validatedInput.description,
      state: TaskState.PENDING,
    });

    // Generate worktree name
    const worktreeName = generateWorktreeName(task.id, validatedInput.title);

    // Log decision
    await decisionLogAccessor.createAutomatic(context.agentId, 'mcp__task__create', 'result', {
      taskId: task.id,
      parentId: topLevelTask.id,
      title: validatedInput.title,
      worktreeName,
    });

    // Fire task.created event (for logging/observability)
    try {
      await inngest.send({
        name: 'task.created',
        data: {
          taskId: task.id,
          parentId: topLevelTask.id,
          title: validatedInput.title,
        },
      });
    } catch (error) {
      console.log(
        'Inngest event send failed (this is OK if Inngest dev server is not running):',
        error
      );
    }

    // Start worker directly (don't wait for Inngest)
    let workerId: string | null = null;
    try {
      workerId = await startWorker(task.id);
      console.log(`Started worker ${workerId} for task ${task.id}`);
    } catch (error) {
      console.error(`Failed to start worker for task ${task.id}:`, error);
      // Don't fail the task creation if worker fails to start
      // The worker can be started manually later
    }

    return createSuccessResponse({
      taskId: task.id,
      title: task.title,
      worktreeName,
      workerId,
      message: workerId
        ? `Task created and worker ${workerId} started.`
        : `Task created. Worker failed to start - can be started manually.`,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

/**
 * List all subtasks for the top-level task (SUPERVISOR only)
 */
async function listTasks(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const validatedInput = ListTasksInputSchema.parse(input);

    // Verify supervisor has top-level task
    const verification = await verifySupervisorWithTopLevelTask(context);
    if (!verification.success) {
      return verification.error;
    }

    // Fetch subtasks
    const tasks = await taskAccessor.list({
      parentId: verification.topLevelTaskId,
      state: validatedInput.state,
    });

    // Log decision
    await decisionLogAccessor.createAutomatic(context.agentId, 'mcp__task__list', 'result', {
      topLevelTaskId: verification.topLevelTaskId,
      taskCount: tasks.length,
      filterState: validatedInput.state,
    });

    return createSuccessResponse({
      topLevelTaskId: verification.topLevelTaskId,
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        state: t.state,
        assignedAgentId: t.assignedAgentId,
        prUrl: t.prUrl,
        worktreePath: t.worktreePath,
        branchName: t.branchName,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        completedAt: t.completedAt,
        failureReason: t.failureReason,
      })),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

/**
 * Get the PR review queue for the top-level task (SUPERVISOR only)
 */
async function getReviewQueue(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    GetReviewQueueInputSchema.parse(input);

    // Verify supervisor has top-level task
    const verification = await verifySupervisorWithTopLevelTask(context);
    if (!verification.success) {
      return verification.error;
    }

    // Fetch tasks in REVIEW state
    const tasks = await taskAccessor.getReviewQueue(verification.topLevelTaskId);

    // Log decision
    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__task__get_review_queue',
      'result',
      {
        topLevelTaskId: verification.topLevelTaskId,
        queueLength: tasks.length,
      }
    );

    return createSuccessResponse({
      topLevelTaskId: verification.topLevelTaskId,
      queue: tasks.map((t, index) => ({
        position: index + 1,
        taskId: t.id,
        title: t.title,
        description: t.description,
        prUrl: t.prUrl,
        worktreePath: t.worktreePath,
        branchName: t.branchName,
        assignedAgentId: t.assignedAgentId,
        submittedAt: t.updatedAt,
      })),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

/**
 * Approve a task and merge worker's branch into top-level task branch (SUPERVISOR only)
 * This does a git merge locally, then pushes the top-level task branch to origin.
 */
async function approveTask(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const validatedInput = ApproveTaskInputSchema.parse(input);

    const verification = await verifySupervisorWithTopLevelTask(context);
    if (!verification.success) {
      return verification.error;
    }

    const taskValidation = await validateTaskForApproval(
      validatedInput.taskId,
      verification.topLevelTaskId
    );
    if (!taskValidation.success) {
      return taskValidation.error;
    }
    const task = taskValidation.task;

    const topLevelValidation = await getTopLevelTaskForApproval(verification.topLevelTaskId);
    if (!topLevelValidation.success) {
      return topLevelValidation.error;
    }
    const { topLevelTask } = topLevelValidation;

    const mergeResult = await mergeTaskBranch(
      topLevelTask.gitClient,
      topLevelTask.topLevelWorktreePath,
      task.branchName,
      task.title
    );
    if (!mergeResult.success) {
      return mergeResult.error;
    }

    const pushed = await tryPushTopLevelBranch(
      topLevelTask.gitClient,
      topLevelTask.topLevelWorktreePath
    );
    await taskAccessor.update(task.id, { state: TaskState.COMPLETED, completedAt: new Date() });

    const topLevelBranchName = `factoryfactory/task-${topLevelTask.id.substring(0, 8)}`;
    const rebaseRequestsSent = await sendRebaseRequests(
      context,
      verification.topLevelTaskId,
      task.id,
      topLevelBranchName
    );
    const workerCleanedUp = await cleanupWorker(task.assignedAgentId);

    await decisionLogAccessor.createAutomatic(context.agentId, 'mcp__task__approve', 'result', {
      taskId: task.id,
      branchName: task.branchName,
      mergeCommit: mergeResult.mergeCommit,
      rebaseRequestsSent,
      workerCleanedUp,
    });

    return createSuccessResponse({
      taskId: task.id,
      branchName: task.branchName,
      mergeCommit: mergeResult.mergeCommit,
      merged: true,
      pushed,
      workerCleanedUp,
      message: buildApprovalMessage(pushed, rebaseRequestsSent, workerCleanedUp),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

/**
 * Request changes on a PR (SUPERVISOR only)
 */
async function requestChanges(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const validatedInput = RequestChangesInputSchema.parse(input);

    // Verify supervisor has top-level task
    const verification = await verifySupervisorWithTopLevelTask(context);
    if (!verification.success) {
      return verification.error;
    }

    // Get task
    const task = await taskAccessor.findById(validatedInput.taskId);
    if (!task) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Task with ID '${validatedInput.taskId}' not found`
      );
    }

    // Verify task belongs to this top-level task
    if (task.parentId !== verification.topLevelTaskId) {
      return createErrorResponse(
        McpErrorCode.PERMISSION_DENIED,
        'Task does not belong to this top-level task'
      );
    }

    // Verify task is in REVIEW state
    if (task.state !== TaskState.REVIEW) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        `Task is in state ${task.state}, expected REVIEW`
      );
    }

    // Verify task has assigned agent
    if (!task.assignedAgentId) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Task does not have an assigned worker'
      );
    }

    // Send feedback mail to worker
    await mailAccessor.create({
      fromAgentId: context.agentId,
      toAgentId: task.assignedAgentId,
      subject: 'Changes Requested',
      body: `Your PR for task "${task.title}" requires changes:\n\n${validatedInput.feedback}\n\nPlease address these issues and update your PR.`,
    });

    // Update task state back to IN_PROGRESS so worker knows to continue
    await taskAccessor.update(task.id, {
      state: TaskState.IN_PROGRESS,
    });

    // Log decision
    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__task__request_changes',
      'result',
      {
        taskId: task.id,
        feedback: validatedInput.feedback,
      }
    );

    return createSuccessResponse({
      taskId: task.id,
      message: 'Feedback sent to worker. Task returned to IN_PROGRESS.',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

/**
 * Force complete a task (SUPERVISOR only)
 * Use when merge conflicts or other issues prevent normal approval.
 * The supervisor should have manually resolved the issue before calling this.
 */
async function forceCompleteTask(
  context: McpToolContext,
  input: unknown
): Promise<McpToolResponse> {
  try {
    const validatedInput = ForceCompleteTaskInputSchema.parse(input);

    // Verify supervisor has top-level task
    const verification = await verifySupervisorWithTopLevelTask(context);
    if (!verification.success) {
      return verification.error;
    }

    // Get task
    const task = await taskAccessor.findById(validatedInput.taskId);
    if (!task) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Task with ID '${validatedInput.taskId}' not found`
      );
    }

    // Verify task belongs to this top-level task
    if (task.parentId !== verification.topLevelTaskId) {
      return createErrorResponse(
        McpErrorCode.PERMISSION_DENIED,
        'Task does not belong to this top-level task'
      );
    }

    // Update task state to COMPLETED
    await taskAccessor.update(task.id, {
      state: TaskState.COMPLETED,
      completedAt: new Date(),
    });

    // Log decision with reason
    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__task__force_complete',
      'result',
      {
        taskId: task.id,
        previousState: task.state,
        reason: validatedInput.reason,
      }
    );

    return createSuccessResponse({
      taskId: task.id,
      previousState: task.state,
      newState: TaskState.COMPLETED,
      message: `Task manually marked as completed. Reason: ${validatedInput.reason}`,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

/**
 * Create PR from top-level task branch to main (SUPERVISOR only)
 * Also cleans up worker tmux sessions for completed tasks
 */
async function createFinalPR(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const validatedInput = CreateFinalPRInputSchema.parse(input);

    const verification = await verifySupervisorWithTopLevelTask(context);
    if (!verification.success) {
      return verification.error;
    }

    const topLevelTask = await taskAccessor.findById(verification.topLevelTaskId);
    if (!topLevelTask) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Top-level task with ID '${verification.topLevelTaskId}' not found`
      );
    }

    const project = topLevelTask.project;
    if (!project) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        `Top-level task '${verification.topLevelTaskId}' does not have an associated project`
      );
    }

    const subtasks = await taskAccessor.findByParentId(topLevelTask.id);
    const incompleteTasks = subtasks.filter(
      (t) => t.state !== TaskState.COMPLETED && t.state !== TaskState.FAILED
    );

    if (incompleteTasks.length > 0) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        `Cannot create PR: ${incompleteTasks.length} task(s) are not complete. Tasks: ${incompleteTasks.map((t) => `${t.title} (${t.state})`).join(', ')}`
      );
    }

    const gitClient = GitClientFactory.forProject({
      repoPath: project.repoPath,
      worktreeBasePath: project.worktreeBasePath,
    });

    const topLevelBranchName = `factoryfactory/task-${topLevelTask.id}`;
    const worktreePath = gitClient.getWorktreePath(`epic-${topLevelTask.id.substring(0, 8)}`);
    const completedTasks = subtasks.filter((t) => t.state === TaskState.COMPLETED);
    const failedTasks = subtasks.filter((t) => t.state === TaskState.FAILED);
    const prTitle = validatedInput.title || `[Task] ${topLevelTask.title}`;
    const prDescription =
      validatedInput.description ||
      generateTopLevelPRDescription(topLevelTask, completedTasks, failedTasks);

    const { prInfo, created: prCreated } = await attemptCreatePR(
      topLevelBranchName,
      prTitle,
      prDescription,
      worktreePath
    );

    const cleanedUpCount = await cleanupAllWorkers(subtasks);
    await taskAccessor.update(topLevelTask.id, {
      state: TaskState.COMPLETED,
      completedAt: new Date(),
    });

    const mailBody = generateTopLevelCompletionMailBody(
      topLevelTask.title,
      topLevelBranchName,
      completedTasks.length,
      failedTasks.length,
      prInfo?.url,
      prCreated
    );

    await mailAccessor.create({
      fromAgentId: context.agentId,
      isForHuman: true,
      subject: `Task Complete: ${topLevelTask.title}`,
      body: mailBody,
    });

    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__task__create_final_pr',
      'result',
      {
        topLevelTaskId: topLevelTask.id,
        prUrl: prInfo?.url || null,
        prNumber: prInfo?.number || null,
        prCreated,
        completedTasks: completedTasks.length,
        failedTasks: failedTasks.length,
        workersCleanedUp: cleanedUpCount,
      }
    );

    await sendTopLevelCompletionNotifications(context, topLevelTask, prInfo?.url || null);

    const message = prCreated
      ? `PR created successfully. ${cleanedUpCount} worker(s) cleaned up. Human review requested.`
      : `Task completed locally (PR skipped - no remote). ${cleanedUpCount} worker(s) cleaned up.`;

    return createSuccessResponse({
      topLevelTaskId: topLevelTask.id,
      prUrl: prInfo?.url || null,
      prNumber: prInfo?.number || null,
      prCreated,
      state: TaskState.COMPLETED,
      workersCleanedUp: cleanedUpCount,
      message,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

// ============================================================================
// Tool Registration
// ============================================================================

export function registerTaskTools(): void {
  // Worker tools
  registerMcpTool({
    name: 'mcp__task__update_state',
    description: 'Update the state of the current task (WORKER only)',
    handler: updateState,
    schema: UpdateStateInputSchema,
  });

  registerMcpTool({
    name: 'mcp__task__create_pr',
    description: 'Create a pull request for the current task (WORKER only)',
    handler: createPR,
    schema: CreatePRInputSchema,
  });

  registerMcpTool({
    name: 'mcp__task__get_pr_status',
    description: 'Get the status of the PR for the current task (WORKER only)',
    handler: getPRStatus,
    schema: GetPRStatusInputSchema,
  });

  // Supervisor tools (task management)
  registerMcpTool({
    name: 'mcp__task__create',
    description: 'Create a new subtask for the top-level task (SUPERVISOR only)',
    handler: createTask,
    schema: CreateTaskInputSchema,
  });

  registerMcpTool({
    name: 'mcp__task__list',
    description:
      'List all subtasks for the top-level task with optional state filter (SUPERVISOR only)',
    handler: listTasks,
    schema: ListTasksInputSchema,
  });

  // Review Queue
  registerMcpTool({
    name: 'mcp__task__get_review_queue',
    description: 'Get tasks ready for review ordered by submission time (SUPERVISOR only)',
    handler: getReviewQueue,
    schema: GetReviewQueueInputSchema,
  });

  // Task Review Actions
  registerMcpTool({
    name: 'mcp__task__approve',
    description:
      'Approve a task, merge worker branch into top-level task branch, and push (SUPERVISOR only)',
    handler: approveTask,
    schema: ApproveTaskInputSchema,
  });

  registerMcpTool({
    name: 'mcp__task__request_changes',
    description: 'Request changes on a task with feedback (SUPERVISOR only)',
    handler: requestChanges,
    schema: RequestChangesInputSchema,
  });

  // Recovery Tools
  registerMcpTool({
    name: 'mcp__task__force_complete',
    description:
      'Force mark a task as completed when normal approval fails (e.g., merge conflicts resolved manually) (SUPERVISOR only)',
    handler: forceCompleteTask,
    schema: ForceCompleteTaskInputSchema,
  });

  // Top-Level Task Completion
  registerMcpTool({
    name: 'mcp__task__create_final_pr',
    description:
      'Create PR from top-level task branch to main when all subtasks are done (SUPERVISOR only)',
    handler: createFinalPR,
    schema: CreateFinalPRInputSchema,
  });
}
