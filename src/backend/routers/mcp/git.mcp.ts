import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentType, TaskState } from '@prisma/client';
import { z } from 'zod';
import {
  agentAccessor,
  decisionLogAccessor,
  epicAccessor,
  taskAccessor,
} from '../../resource_accessors/index.js';
import { createErrorResponse, createSuccessResponse, registerMcpTool } from './server.js';
import type { McpToolContext, McpToolResponse } from './types.js';
import { McpErrorCode } from './types.js';

const execAsync = promisify(exec);

// ============================================================================
// Input Schemas
// ============================================================================

const GetDiffInputSchema = z.object({});

const RebaseInputSchema = z.object({});

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Get diff between task branch and epic branch (WORKER only)
 */
async function getDiff(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    GetDiffInputSchema.parse(input);

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
        'Only WORKER agents can get git diff'
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

    // Get epic
    const epic = await epicAccessor.findById(task.epicId);
    if (!epic) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Epic with ID '${task.epicId}' not found`
      );
    }

    // Verify task has worktree
    if (!task.worktreePath) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Task does not have a worktree path'
      );
    }

    // Verify task has branch
    if (!task.branchName) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Task does not have a branch name'
      );
    }

    // Get epic branch name
    const epicBranchName = `factoryfactory/epic-${epic.id}`;

    // Get diff stats
    let diffStats;
    try {
      const { stdout: statsOutput } = await execAsync(
        `git -C "${task.worktreePath}" diff --stat ${epicBranchName}...HEAD`
      );
      diffStats = statsOutput;
    } catch (error) {
      return createErrorResponse(
        McpErrorCode.INTERNAL_ERROR,
        `Failed to get diff stats: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Get full diff
    let diffContent;
    try {
      const { stdout: diffOutput } = await execAsync(
        `git -C "${task.worktreePath}" diff ${epicBranchName}...HEAD`
      );
      diffContent = diffOutput;
    } catch (error) {
      return createErrorResponse(
        McpErrorCode.INTERNAL_ERROR,
        `Failed to get diff content: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Parse stats to get files changed, insertions, deletions
    const statsMatch = diffStats.match(
      /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/
    );
    const filesChanged = statsMatch ? parseInt(statsMatch[1], 10) : 0;
    const insertions = statsMatch?.[2] ? parseInt(statsMatch[2], 10) : 0;
    const deletions = statsMatch?.[3] ? parseInt(statsMatch[3], 10) : 0;

    // Log decision
    await decisionLogAccessor.createAutomatic(context.agentId, 'mcp__git__get_diff', 'result', {
      taskId: task.id,
      epicBranch: epicBranchName,
      taskBranch: task.branchName,
      filesChanged,
      insertions,
      deletions,
    });

    return createSuccessResponse({
      taskId: task.id,
      epicBranch: epicBranchName,
      taskBranch: task.branchName,
      filesChanged,
      insertions,
      deletions,
      stats: diffStats,
      diff: diffContent,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.errors);
    }
    throw error;
  }
}

/**
 * Rebase task branch onto epic branch (WORKER only)
 */
async function rebase(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    RebaseInputSchema.parse(input);

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
      return createErrorResponse(McpErrorCode.PERMISSION_DENIED, 'Only WORKER agents can rebase');
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

    // Get epic
    const epic = await epicAccessor.findById(task.epicId);
    if (!epic) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Epic with ID '${task.epicId}' not found`
      );
    }

    // Verify task has worktree
    if (!task.worktreePath) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Task does not have a worktree path'
      );
    }

    // Verify task has branch
    if (!task.branchName) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Task does not have a branch name'
      );
    }

    // Get epic branch name
    const epicBranchName = `factoryfactory/epic-${epic.id}`;

    // Fetch latest changes
    try {
      await execAsync(`git -C "${task.worktreePath}" fetch origin ${epicBranchName}`);
    } catch (error) {
      return createErrorResponse(
        McpErrorCode.INTERNAL_ERROR,
        `Failed to fetch epic branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Attempt rebase
    let rebaseSuccess = true;
    let rebaseError = '';
    let conflictFiles: string[] = [];

    try {
      await execAsync(`git -C "${task.worktreePath}" rebase ${epicBranchName}`);
    } catch (error) {
      rebaseSuccess = false;
      rebaseError = error instanceof Error ? error.message : String(error);

      // Check for conflicts
      try {
        const { stdout } = await execAsync(
          `git -C "${task.worktreePath}" diff --name-only --diff-filter=U`
        );
        conflictFiles = stdout.split('\n').filter((line) => line.trim().length > 0);
      } catch {
        // Ignore error getting conflict files
      }

      // Abort the rebase
      try {
        await execAsync(`git -C "${task.worktreePath}" rebase --abort`);
      } catch {
        // Ignore abort error
      }
    }

    if (!rebaseSuccess) {
      // Update task state to BLOCKED
      await taskAccessor.update(task.id, {
        state: TaskState.BLOCKED,
        failureReason: `Rebase conflicts: ${conflictFiles.join(', ')}`,
      });

      // Log decision
      await decisionLogAccessor.createAutomatic(context.agentId, 'mcp__git__rebase', 'error', {
        taskId: task.id,
        epicBranch: epicBranchName,
        taskBranch: task.branchName,
        conflictFiles,
        error: rebaseError,
      });

      return createErrorResponse(McpErrorCode.INTERNAL_ERROR, 'Rebase failed with conflicts', {
        conflictFiles,
        error: rebaseError,
      });
    }

    // Force push rebased branch
    try {
      await execAsync(
        `git -C "${task.worktreePath}" push --force-with-lease origin ${task.branchName}`
      );
    } catch (error) {
      return createErrorResponse(
        McpErrorCode.INTERNAL_ERROR,
        `Failed to push rebased branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Log decision
    await decisionLogAccessor.createAutomatic(context.agentId, 'mcp__git__rebase', 'result', {
      taskId: task.id,
      epicBranch: epicBranchName,
      taskBranch: task.branchName,
      success: true,
    });

    return createSuccessResponse({
      taskId: task.id,
      epicBranch: epicBranchName,
      taskBranch: task.branchName,
      success: true,
      message: 'Rebase completed successfully and branch force-pushed',
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

export function registerGitTools(): void {
  registerMcpTool({
    name: 'mcp__git__get_diff',
    description: 'Get diff between task branch and epic branch (WORKER only)',
    handler: getDiff,
    schema: GetDiffInputSchema,
  });

  registerMcpTool({
    name: 'mcp__git__rebase',
    description: 'Rebase task branch onto epic branch (WORKER only)',
    handler: rebase,
    schema: RebaseInputSchema,
  });
}
