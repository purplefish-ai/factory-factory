import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AgentType, EpicState, TaskState } from '@prisma-gen/client';
import { z } from 'zod';
import { startWorker } from '../../agents/worker/lifecycle.js';
import { gitClient } from '../../clients/git.client.js';
import { githubClient } from '../../clients/index.js';
import { inngest } from '../../inngest/client.js';
import {
  agentAccessor,
  decisionLogAccessor,
  epicAccessor,
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

const ReadFileInputSchema = z.object({
  taskId: z.string().min(1, 'Task ID is required'),
  filePath: z.string().min(1, 'File path is required'),
});

const CreateEpicPRInputSchema = z.object({
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
 * Verify agent is a SUPERVISOR with an epic assigned
 */
async function verifySupervisorWithEpic(
  context: McpToolContext
): Promise<
  { success: true; agentId: string; epicId: string } | { success: false; error: McpToolResponse }
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
        'Only SUPERVISOR agents can use epic tools'
      ),
    };
  }

  if (!agent.currentEpicId) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Supervisor does not have an epic assigned'
      ),
    };
  }

  return { success: true, agentId: agent.id, epicId: agent.currentEpicId };
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

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Create a new task for the epic (SUPERVISOR only)
 */
async function createTask(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const validatedInput = CreateTaskInputSchema.parse(input);

    // Verify supervisor has epic
    const verification = await verifySupervisorWithEpic(context);
    if (!verification.success) {
      return verification.error;
    }

    // Get epic
    const epic = await epicAccessor.findById(verification.epicId);
    if (!epic) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Epic with ID '${verification.epicId}' not found`
      );
    }

    // Create task record
    const task = await taskAccessor.create({
      epicId: epic.id,
      title: validatedInput.title,
      description: validatedInput.description,
      state: TaskState.PENDING,
    });

    // Generate worktree name
    const worktreeName = generateWorktreeName(task.id, validatedInput.title);

    // Log decision
    await decisionLogAccessor.createAutomatic(context.agentId, 'mcp__epic__create_task', 'result', {
      taskId: task.id,
      epicId: epic.id,
      title: validatedInput.title,
      worktreeName,
    });

    // Fire task.created event (for logging/observability)
    try {
      await inngest.send({
        name: 'task.created',
        data: {
          taskId: task.id,
          epicId: epic.id,
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
 * List all tasks for the epic (SUPERVISOR only)
 */
async function listTasks(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const validatedInput = ListTasksInputSchema.parse(input);

    // Verify supervisor has epic
    const verification = await verifySupervisorWithEpic(context);
    if (!verification.success) {
      return verification.error;
    }

    // Fetch tasks for epic
    const tasks = await taskAccessor.list({
      epicId: verification.epicId,
      state: validatedInput.state,
    });

    // Log decision
    await decisionLogAccessor.createAutomatic(context.agentId, 'mcp__epic__list_tasks', 'result', {
      epicId: verification.epicId,
      taskCount: tasks.length,
      filterState: validatedInput.state,
    });

    return createSuccessResponse({
      epicId: verification.epicId,
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
 * Get the PR review queue for the epic (SUPERVISOR only)
 */
async function getReviewQueue(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    GetReviewQueueInputSchema.parse(input);

    // Verify supervisor has epic
    const verification = await verifySupervisorWithEpic(context);
    if (!verification.success) {
      return verification.error;
    }

    // Fetch tasks in REVIEW state
    const tasks = await taskAccessor.list({
      epicId: verification.epicId,
      state: TaskState.REVIEW,
    });

    // Sort by updatedAt (submission order)
    const sortedTasks = tasks.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());

    // Log decision
    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__epic__get_review_queue',
      'result',
      {
        epicId: verification.epicId,
        queueLength: sortedTasks.length,
      }
    );

    return createSuccessResponse({
      epicId: verification.epicId,
      queue: sortedTasks.map((t, index) => ({
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
 * Send rebase requests to other workers in review
 */
async function sendRebaseRequests(
  context: McpToolContext,
  epicId: string,
  excludeTaskId: string,
  epicBranchName: string
): Promise<number> {
  const otherReviewTasks = await taskAccessor.list({ epicId, state: TaskState.REVIEW });
  let count = 0;

  for (const reviewTask of otherReviewTasks) {
    if (reviewTask.id !== excludeTaskId && reviewTask.assignedAgentId) {
      await taskAccessor.update(reviewTask.id, { state: TaskState.BLOCKED });
      await mailAccessor.create({
        fromAgentId: context.agentId,
        toAgentId: reviewTask.assignedAgentId,
        subject: 'Rebase Required',
        body: `Another task has been merged into the epic branch. Please rebase your branch against the epic branch before I can review your code.\n\nTask: ${reviewTask.title}\nEpic branch: ${epicBranchName}\n\nRun: git fetch origin && git rebase origin/${epicBranchName}`,
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

interface EpicForApproval {
  id: string;
  epicId: string;
  epicWorktreePath: string;
}

/**
 * Validate task is ready for approval
 */
async function validateTaskForApproval(
  taskId: string,
  epicId: string
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
  if (task.epicId !== epicId) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.PERMISSION_DENIED,
        'Task does not belong to this epic'
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
 * Get epic and worktree path for approval
 */
async function getEpicForApproval(
  epicId: string
): Promise<{ success: true; epic: EpicForApproval } | { success: false; error: McpToolResponse }> {
  const epic = await epicAccessor.findById(epicId);
  if (!epic) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Epic with ID '${epicId}' not found`
      ),
    };
  }
  const epicWorktreeName = `epic-${epic.id.substring(0, 8)}`;
  return {
    success: true,
    epic: { id: epic.id, epicId, epicWorktreePath: gitClient.getWorktreePath(epicWorktreeName) },
  };
}

/**
 * Merge a task branch into the epic worktree
 */
async function mergeTaskBranch(
  epicWorktreePath: string,
  branchName: string,
  taskTitle: string
): Promise<{ success: true; mergeCommit: string } | { success: false; error: McpToolResponse }> {
  try {
    const result = await gitClient.mergeBranch(
      epicWorktreePath,
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
 * Try to push the epic branch, returns whether push succeeded
 */
async function tryPushEpicBranch(epicWorktreePath: string): Promise<boolean> {
  try {
    await gitClient.pushBranchWithUpstream(epicWorktreePath);
    return true;
  } catch (error) {
    console.log(
      `Note: Could not push epic branch (this is OK for local testing): ${error instanceof Error ? error.message : String(error)}`
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
    ? 'merged into epic and pushed'
    : 'merged into epic locally (push skipped - no remote)';
  const workerStatus = workerCleanedUp ? ' Worker cleaned up.' : '';
  return `Task approved. Branch ${pushStatus}. ${rebaseRequestsSent} rebase requests sent.${workerStatus}`;
}

/**
 * Approve a task and merge worker's branch into epic branch (SUPERVISOR only)
 * This does a git merge locally, then pushes the epic branch to origin.
 */
async function approveTask(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const validatedInput = ApproveTaskInputSchema.parse(input);

    const verification = await verifySupervisorWithEpic(context);
    if (!verification.success) {
      return verification.error;
    }

    const taskValidation = await validateTaskForApproval(
      validatedInput.taskId,
      verification.epicId
    );
    if (!taskValidation.success) {
      return taskValidation.error;
    }
    const task = taskValidation.task;

    const epicValidation = await getEpicForApproval(verification.epicId);
    if (!epicValidation.success) {
      return epicValidation.error;
    }
    const { epic } = epicValidation;

    const mergeResult = await mergeTaskBranch(epic.epicWorktreePath, task.branchName, task.title);
    if (!mergeResult.success) {
      return mergeResult.error;
    }

    const pushed = await tryPushEpicBranch(epic.epicWorktreePath);
    await taskAccessor.update(task.id, { state: TaskState.COMPLETED, completedAt: new Date() });

    const epicBranchName = `factoryfactory/epic-${epic.id.substring(0, 8)}`;
    const rebaseRequestsSent = await sendRebaseRequests(
      context,
      verification.epicId,
      task.id,
      epicBranchName
    );
    const workerCleanedUp = await cleanupWorker(task.assignedAgentId);

    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__epic__approve_task',
      'result',
      {
        taskId: task.id,
        branchName: task.branchName,
        mergeCommit: mergeResult.mergeCommit,
        rebaseRequestsSent,
        workerCleanedUp,
      }
    );

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

    // Verify supervisor has epic
    const verification = await verifySupervisorWithEpic(context);
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

    // Verify task belongs to this epic
    if (task.epicId !== verification.epicId) {
      return createErrorResponse(
        McpErrorCode.PERMISSION_DENIED,
        'Task does not belong to this epic'
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
      'mcp__epic__request_changes',
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
 * Read a file from a worker's worktree (SUPERVISOR only)
 */
async function readFile(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const validatedInput = ReadFileInputSchema.parse(input);

    // Verify supervisor has epic
    const verification = await verifySupervisorWithEpic(context);
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

    // Verify task belongs to this epic
    if (task.epicId !== verification.epicId) {
      return createErrorResponse(
        McpErrorCode.PERMISSION_DENIED,
        'Task does not belong to this epic'
      );
    }

    // Verify task has worktree
    if (!task.worktreePath) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Task does not have a worktree path'
      );
    }

    // Build full file path
    const fullPath = path.join(task.worktreePath, validatedInput.filePath);

    // Security check: ensure path doesn't escape worktree
    const resolvedPath = path.resolve(fullPath);
    const resolvedWorktree = path.resolve(task.worktreePath);
    if (!resolvedPath.startsWith(resolvedWorktree)) {
      return createErrorResponse(
        McpErrorCode.PERMISSION_DENIED,
        'File path must be within the task worktree'
      );
    }

    // Read file
    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return createErrorResponse(
          McpErrorCode.RESOURCE_NOT_FOUND,
          `File not found: ${validatedInput.filePath}`
        );
      }
      throw error;
    }

    // Log decision
    await decisionLogAccessor.createAutomatic(context.agentId, 'mcp__epic__read_file', 'result', {
      taskId: task.id,
      filePath: validatedInput.filePath,
      contentLength: content.length,
    });

    return createSuccessResponse({
      taskId: task.id,
      filePath: validatedInput.filePath,
      content,
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

    // Verify supervisor has epic
    const verification = await verifySupervisorWithEpic(context);
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

    // Verify task belongs to this epic
    if (task.epicId !== verification.epicId) {
      return createErrorResponse(
        McpErrorCode.PERMISSION_DENIED,
        'Task does not belong to this epic'
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
      'mcp__epic__force_complete_task',
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
 * Generate PR description for epic completion
 */
function generateEpicPRDescription(
  epic: { title: string; description: string | null },
  completedTasks: { title: string }[],
  failedTasks: { title: string; failureReason: string | null }[]
): string {
  const failedSection =
    failedTasks.length > 0
      ? `## Failed Tasks (${failedTasks.length})\n${failedTasks.map((t) => `- ❌ ${t.title}: ${t.failureReason || 'No reason'}`).join('\n')}`
      : '';

  return `## Epic: ${epic.title}

${epic.description || 'No description provided.'}

## Completed Tasks (${completedTasks.length})
${completedTasks.map((t) => `- ✅ ${t.title}`).join('\n')}

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
 * Send notifications after epic completion
 */
async function sendEpicCompletionNotifications(
  context: McpToolContext,
  epic: { id: string; title: string },
  prUrl: string | null
): Promise<void> {
  try {
    await notificationService.notifyEpicComplete(epic.title, prUrl || undefined);
  } catch (error) {
    console.error('Failed to send epic completion notification:', error);
  }

  try {
    await inngest.send({
      name: 'agent.completed',
      data: { agentId: context.agentId, epicId: epic.id },
    });
  } catch (error) {
    console.log(
      'Inngest event send failed (this is OK if Inngest dev server is not running):',
      error
    );
  }
}

/**
 * Create PR from epic branch to main (SUPERVISOR only)
 * Also cleans up worker tmux sessions for completed tasks
 */
async function createEpicPR(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const validatedInput = CreateEpicPRInputSchema.parse(input);

    const verification = await verifySupervisorWithEpic(context);
    if (!verification.success) {
      return verification.error;
    }

    const epic = await epicAccessor.findById(verification.epicId);
    if (!epic) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Epic with ID '${verification.epicId}' not found`
      );
    }

    const tasks = await taskAccessor.list({ epicId: epic.id });
    const incompleteTasks = tasks.filter(
      (t) => t.state !== TaskState.COMPLETED && t.state !== TaskState.FAILED
    );

    if (incompleteTasks.length > 0) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        `Cannot create epic PR: ${incompleteTasks.length} task(s) are not complete. Tasks: ${incompleteTasks.map((t) => `${t.title} (${t.state})`).join(', ')}`
      );
    }

    const epicBranchName = `factoryfactory/epic-${epic.id}`;
    const worktreePath = gitClient.getWorktreePath(`epic-${epic.id.substring(0, 8)}`);
    const completedTasks = tasks.filter((t) => t.state === TaskState.COMPLETED);
    const failedTasks = tasks.filter((t) => t.state === TaskState.FAILED);
    const prTitle = validatedInput.title || `[Epic] ${epic.title}`;
    const prDescription =
      validatedInput.description || generateEpicPRDescription(epic, completedTasks, failedTasks);

    const { prInfo, created: prCreated } = await attemptCreatePR(
      epicBranchName,
      prTitle,
      prDescription,
      worktreePath
    );

    const cleanedUpCount = await cleanupAllWorkers(tasks);
    await epicAccessor.update(epic.id, { state: EpicState.COMPLETED, completedAt: new Date() });

    const mailBody = prCreated
      ? `The epic "${epic.title}" has been completed and is ready for review.\n\nPR URL: ${prInfo?.url}\nBranch: ${epicBranchName}\n\nCompleted tasks: ${completedTasks.length}\nFailed tasks: ${failedTasks.length}`
      : `The epic "${epic.title}" has been completed locally.\n\nNote: PR could not be created (no remote configured).\nBranch: ${epicBranchName}\n\nCompleted tasks: ${completedTasks.length}\nFailed tasks: ${failedTasks.length}`;

    await mailAccessor.create({
      fromAgentId: context.agentId,
      isForHuman: true,
      subject: `Epic Complete: ${epic.title}`,
      body: mailBody,
    });

    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__epic__create_epic_pr',
      'result',
      {
        epicId: epic.id,
        prUrl: prInfo?.url || null,
        prNumber: prInfo?.number || null,
        prCreated,
        completedTasks: completedTasks.length,
        failedTasks: failedTasks.length,
        workersCleanedUp: cleanedUpCount,
      }
    );

    await sendEpicCompletionNotifications(context, epic, prInfo?.url || null);

    return createSuccessResponse({
      epicId: epic.id,
      prUrl: prInfo?.url || null,
      prNumber: prInfo?.number || null,
      prCreated,
      state: EpicState.COMPLETED,
      workersCleanedUp: cleanedUpCount,
      message: prCreated
        ? `Epic PR created successfully. ${cleanedUpCount} worker(s) cleaned up. Human review requested.`
        : `Epic completed locally (PR skipped - no remote). ${cleanedUpCount} worker(s) cleaned up.`,
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

export function registerEpicTools(): void {
  // Task Management
  registerMcpTool({
    name: 'mcp__epic__create_task',
    description: 'Create a new task for the epic (SUPERVISOR only)',
    handler: createTask,
    schema: CreateTaskInputSchema,
  });

  registerMcpTool({
    name: 'mcp__epic__list_tasks',
    description: 'List all tasks for the epic with optional state filter (SUPERVISOR only)',
    handler: listTasks,
    schema: ListTasksInputSchema,
  });

  // Review Queue
  registerMcpTool({
    name: 'mcp__epic__get_review_queue',
    description: 'Get tasks ready for review ordered by submission time (SUPERVISOR only)',
    handler: getReviewQueue,
    schema: GetReviewQueueInputSchema,
  });

  // Task Review Actions
  registerMcpTool({
    name: 'mcp__epic__approve_task',
    description: 'Approve a task, merge worker branch into epic branch, and push (SUPERVISOR only)',
    handler: approveTask,
    schema: ApproveTaskInputSchema,
  });

  registerMcpTool({
    name: 'mcp__epic__request_changes',
    description: 'Request changes on a task with feedback (SUPERVISOR only)',
    handler: requestChanges,
    schema: RequestChangesInputSchema,
  });

  registerMcpTool({
    name: 'mcp__epic__read_file',
    description: "Read a file from a worker's worktree for code review (SUPERVISOR only)",
    handler: readFile,
    schema: ReadFileInputSchema,
  });

  // Recovery Tools
  registerMcpTool({
    name: 'mcp__epic__force_complete_task',
    description:
      'Force mark a task as completed when normal approval fails (e.g., merge conflicts resolved manually) (SUPERVISOR only)',
    handler: forceCompleteTask,
    schema: ForceCompleteTaskInputSchema,
  });

  // Epic Completion
  registerMcpTool({
    name: 'mcp__epic__create_epic_pr',
    description: 'Create PR from epic branch to main when all tasks are done (SUPERVISOR only)',
    handler: createEpicPR,
    schema: CreateEpicPRInputSchema,
  });
}
