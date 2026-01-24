import { AgentType, TaskState } from '@prisma-gen/client';
import { z } from 'zod';
import type { PRInfo, PRStatus } from '../../clients/github.client.js';
import { githubClient } from '../../clients/index.js';
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

const UpdateStateInputSchema = z.object({
  state: z.nativeEnum(TaskState),
  failureReason: z.string().optional(),
});

const CreatePRInputSchema = z.object({
  title: z.string(),
  description: z.string(),
});

const GetPRStatusInputSchema = z.object({});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate state transition is allowed
 */
function isValidStateTransition(from: TaskState, to: TaskState): boolean {
  const validTransitions: Record<TaskState, TaskState[]> = {
    [TaskState.PENDING]: [TaskState.ASSIGNED, TaskState.IN_PROGRESS],
    [TaskState.ASSIGNED]: [TaskState.IN_PROGRESS, TaskState.PENDING],
    [TaskState.IN_PROGRESS]: [TaskState.REVIEW, TaskState.BLOCKED, TaskState.FAILED],
    [TaskState.REVIEW]: [TaskState.COMPLETED, TaskState.IN_PROGRESS, TaskState.BLOCKED],
    [TaskState.BLOCKED]: [TaskState.IN_PROGRESS, TaskState.FAILED],
    [TaskState.COMPLETED]: [],
    [TaskState.FAILED]: [TaskState.IN_PROGRESS],
  };

  return validTransitions[from]?.includes(to) ?? false;
}

interface WorkerTaskContext {
  agentId: string;
  task: { id: string; epicId: string; branchName: string; worktreePath: string; title: string };
  epic: { id: string };
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

  const epic = await epicAccessor.findById(task.epicId);
  if (!epic) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Epic with ID '${task.epicId}' not found`
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
        epicId: task.epicId,
        branchName: task.branchName,
        worktreePath: task.worktreePath,
        title: task.title,
      },
      epic: { id: epic.id },
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
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.errors);
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
    const { task, epic, agentId } = validation.data;

    const epicBranchName = `factoryfactory/epic-${epic.id}`;

    let prInfo: PRInfo;
    try {
      prInfo = await githubClient.createPR(
        task.branchName,
        epicBranchName,
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

    const orchestrator = await agentAccessor.findByEpicId(epic.id);
    if (orchestrator) {
      await mailAccessor.create({
        fromAgentId: agentId,
        toAgentId: orchestrator.id,
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
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.errors);
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
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.errors);
    }
    throw error;
  }
}

// ============================================================================
// Tool Registration
// ============================================================================

export function registerTaskTools(): void {
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
}
