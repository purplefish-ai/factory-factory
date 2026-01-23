import { z } from 'zod';
import { AgentType, TaskState, EpicState } from '@prisma/client';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  agentAccessor,
  taskAccessor,
  epicAccessor,
  decisionLogAccessor,
  mailAccessor,
} from '../../resource_accessors/index.js';
import { githubClient } from '../../clients/index.js';
import { gitClient } from '../../clients/git.client.js';
import { McpToolContext, McpToolResponse, McpErrorCode } from './types.js';
import {
  registerMcpTool,
  createSuccessResponse,
  createErrorResponse,
} from './server.js';
import { inngest } from '../../inngest/client.js';
import { startWorker } from '../../agents/worker/lifecycle.js';

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
  | { success: true; agentId: string; epicId: string }
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
async function createTask(
  context: McpToolContext,
  input: unknown
): Promise<McpToolResponse> {
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
    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__epic__create_task',
      'result',
      {
        taskId: task.id,
        epicId: epic.id,
        title: validatedInput.title,
        worktreeName,
      }
    );

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
      console.log('Inngest event send failed (this is OK if Inngest dev server is not running):', error);
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
      return createErrorResponse(
        McpErrorCode.INVALID_INPUT,
        'Invalid input',
        error.errors
      );
    }
    throw error;
  }
}

/**
 * List all tasks for the epic (SUPERVISOR only)
 */
async function listTasks(
  context: McpToolContext,
  input: unknown
): Promise<McpToolResponse> {
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
    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__epic__list_tasks',
      'result',
      {
        epicId: verification.epicId,
        taskCount: tasks.length,
        filterState: validatedInput.state,
      }
    );

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
      return createErrorResponse(
        McpErrorCode.INVALID_INPUT,
        'Invalid input',
        error.errors
      );
    }
    throw error;
  }
}

/**
 * Get the PR review queue for the epic (SUPERVISOR only)
 */
async function getReviewQueue(
  context: McpToolContext,
  input: unknown
): Promise<McpToolResponse> {
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
    const sortedTasks = tasks.sort(
      (a, b) => a.updatedAt.getTime() - b.updatedAt.getTime()
    );

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
      return createErrorResponse(
        McpErrorCode.INVALID_INPUT,
        'Invalid input',
        error.errors
      );
    }
    throw error;
  }
}

/**
 * Approve a task and merge worker's branch into epic branch (SUPERVISOR only)
 * This does a git merge locally, then pushes the epic branch to origin.
 */
async function approveTask(
  context: McpToolContext,
  input: unknown
): Promise<McpToolResponse> {
  try {
    const validatedInput = ApproveTaskInputSchema.parse(input);

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

    // Verify task has a branch
    if (!task.branchName) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Task does not have a branch name'
      );
    }

    // Get epic for worktree path
    const epic = await epicAccessor.findById(verification.epicId);
    if (!epic) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Epic with ID '${verification.epicId}' not found`
      );
    }

    // Get the epic worktree path
    const epicWorktreeName = `epic-${epic.id.substring(0, 8)}`;
    const epicWorktreePath = gitClient.getWorktreePath(epicWorktreeName);

    // Merge the worker's branch into the epic branch
    let mergeResult: { success: boolean; mergeCommit: string };
    try {
      mergeResult = await gitClient.mergeBranch(
        epicWorktreePath,
        task.branchName,
        `Merge task: ${task.title}`
      );
    } catch (error) {
      return createErrorResponse(
        McpErrorCode.INTERNAL_ERROR,
        `Failed to merge branch ${task.branchName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Push the epic branch to origin (optional - may fail if no remote configured)
    let pushed = false;
    try {
      await gitClient.pushBranchWithUpstream(epicWorktreePath);
      pushed = true;
    } catch (error) {
      console.log(`Note: Could not push epic branch (this is OK for local testing): ${error instanceof Error ? error.message : String(error)}`);
    }

    // Update task state to COMPLETED
    await taskAccessor.update(task.id, {
      state: TaskState.COMPLETED,
      completedAt: new Date(),
    });

    // Find all other tasks in REVIEW state and notify them to rebase
    const otherReviewTasks = await taskAccessor.list({
      epicId: verification.epicId,
      state: TaskState.REVIEW,
    });

    // Get epic branch name for rebase instructions
    const epicBranchName = `factoryfactory/epic-${epic.id.substring(0, 8)}`;

    // Send rebase request mail to each worker
    for (const reviewTask of otherReviewTasks) {
      if (reviewTask.id !== task.id && reviewTask.assignedAgentId) {
        // Update task state to indicate rebase needed
        await taskAccessor.update(reviewTask.id, {
          state: TaskState.BLOCKED, // Use BLOCKED to indicate rebase needed
        });

        // Send mail to worker
        await mailAccessor.create({
          fromAgentId: context.agentId,
          toAgentId: reviewTask.assignedAgentId,
          subject: 'Rebase Required',
          body: `Another task has been merged into the epic branch. Please rebase your branch against the epic branch before I can review your code.\n\nTask: ${reviewTask.title}\nEpic branch: ${epicBranchName}\n\nRun: git fetch origin && git rebase origin/${epicBranchName}`,
        });
      }
    }

    // Log decision
    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__epic__approve_task',
      'result',
      {
        taskId: task.id,
        branchName: task.branchName,
        mergeCommit: mergeResult.mergeCommit,
        rebaseRequestsSent: otherReviewTasks.length,
      }
    );

    return createSuccessResponse({
      taskId: task.id,
      branchName: task.branchName,
      mergeCommit: mergeResult.mergeCommit,
      merged: true,
      pushed,
      message: pushed
        ? `Task approved. Branch merged into epic and pushed. ${otherReviewTasks.length} rebase requests sent.`
        : `Task approved. Branch merged into epic locally (push skipped - no remote). ${otherReviewTasks.length} rebase requests sent.`,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(
        McpErrorCode.INVALID_INPUT,
        'Invalid input',
        error.errors
      );
    }
    throw error;
  }
}

/**
 * Request changes on a PR (SUPERVISOR only)
 */
async function requestChanges(
  context: McpToolContext,
  input: unknown
): Promise<McpToolResponse> {
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
      return createErrorResponse(
        McpErrorCode.INVALID_INPUT,
        'Invalid input',
        error.errors
      );
    }
    throw error;
  }
}

/**
 * Read a file from a worker's worktree (SUPERVISOR only)
 */
async function readFile(
  context: McpToolContext,
  input: unknown
): Promise<McpToolResponse> {
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
    await decisionLogAccessor.createAutomatic(
      context.agentId,
      'mcp__epic__read_file',
      'result',
      {
        taskId: task.id,
        filePath: validatedInput.filePath,
        contentLength: content.length,
      }
    );

    return createSuccessResponse({
      taskId: task.id,
      filePath: validatedInput.filePath,
      content,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(
        McpErrorCode.INVALID_INPUT,
        'Invalid input',
        error.errors
      );
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
      return createErrorResponse(
        McpErrorCode.INVALID_INPUT,
        'Invalid input',
        error.errors
      );
    }
    throw error;
  }
}

/**
 * Create PR from epic branch to main (SUPERVISOR only)
 * Also cleans up worker tmux sessions for completed tasks
 */
async function createEpicPR(
  context: McpToolContext,
  input: unknown
): Promise<McpToolResponse> {
  try {
    const validatedInput = CreateEpicPRInputSchema.parse(input);

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

    // Check all tasks are completed or failed
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

    // Get epic branch name
    const epicBranchName = `factoryfactory/epic-${epic.id}`;

    // Get worktree path from git client
    const worktreeName = `epic-${epic.id.substring(0, 8)}`;
    const worktreePath = gitClient.getWorktreePath(worktreeName);

    // Create PR title and description
    const prTitle = validatedInput.title || `[Epic] ${epic.title}`;
    const completedTasks = tasks.filter((t) => t.state === TaskState.COMPLETED);
    const failedTasks = tasks.filter((t) => t.state === TaskState.FAILED);

    const prDescription = validatedInput.description || `## Epic: ${epic.title}

${epic.description || 'No description provided.'}

## Completed Tasks (${completedTasks.length})
${completedTasks.map((t) => `- ✅ ${t.title}`).join('\n')}

${failedTasks.length > 0 ? `## Failed Tasks (${failedTasks.length})\n${failedTasks.map((t) => `- ❌ ${t.title}: ${t.failureReason || 'No reason'}`).join('\n')}` : ''}

---
*This PR was created by the FactoryFactory Supervisor agent.*`;

    // Try to create PR (may fail if no remote configured)
    let prInfo: { url: string; number: number } | null = null;
    let prCreated = false;
    try {
      prInfo = await githubClient.createPR(
        epicBranchName,
        'main',
        prTitle,
        prDescription,
        worktreePath
      );
      prCreated = true;
    } catch (error) {
      console.log(`Note: Could not create PR (this is OK for local testing): ${error instanceof Error ? error.message : String(error)}`);
    }

    // Clean up worker tmux sessions for all tasks
    const { killWorkerAndCleanup } = await import('../../agents/worker/lifecycle.js');
    let cleanedUpCount = 0;
    for (const task of tasks) {
      if (task.assignedAgentId) {
        try {
          await killWorkerAndCleanup(task.assignedAgentId);
          cleanedUpCount++;
        } catch (error) {
          console.log(`Note: Could not clean up worker ${task.assignedAgentId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    console.log(`Cleaned up ${cleanedUpCount} worker session(s)`);

    // Update epic state
    await epicAccessor.update(epic.id, {
      state: EpicState.COMPLETED,
      completedAt: new Date(),
    });

    // Send mail to human inbox
    await mailAccessor.create({
      fromAgentId: context.agentId,
      isForHuman: true,
      subject: `Epic Complete: ${epic.title}`,
      body: prCreated
        ? `The epic "${epic.title}" has been completed and is ready for review.\n\nPR URL: ${prInfo!.url}\n\nCompleted tasks: ${completedTasks.length}\nFailed tasks: ${failedTasks.length}`
        : `The epic "${epic.title}" has been completed locally.\n\nNote: PR could not be created (no remote configured).\n\nCompleted tasks: ${completedTasks.length}\nFailed tasks: ${failedTasks.length}`,
    });

    // Log decision
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
      return createErrorResponse(
        McpErrorCode.INVALID_INPUT,
        'Invalid input',
        error.errors
      );
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
    description: 'Read a file from a worker\'s worktree for code review (SUPERVISOR only)',
    handler: readFile,
    schema: ReadFileInputSchema,
  });

  // Recovery Tools
  registerMcpTool({
    name: 'mcp__epic__force_complete_task',
    description: 'Force mark a task as completed when normal approval fails (e.g., merge conflicts resolved manually) (SUPERVISOR only)',
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
