import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentType, TaskState } from '@prisma-gen/client';
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
 * Verify worker agent and get task context
 */
async function verifyWorkerWithTask(context: McpToolContext): Promise<
  | {
      success: true;
      task: { id: string; worktreePath: string; branchName: string; epicId: string };
    }
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

  if (agent.type !== AgentType.WORKER) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.PERMISSION_DENIED,
        'Only WORKER agents can use git tools'
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

  if (!task.worktreePath) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Task does not have a worktree path'
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
      worktreePath: task.worktreePath,
      branchName: task.branchName,
      epicId: task.epicId,
    },
  };
}

/**
 * Parse diff stats output
 */
function parseDiffStats(diffStats: string): {
  filesChanged: number;
  insertions: number;
  deletions: number;
} {
  const statsMatch = diffStats.match(
    /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/
  );
  return {
    filesChanged: statsMatch ? Number.parseInt(statsMatch[1], 10) : 0,
    insertions: statsMatch?.[2] ? Number.parseInt(statsMatch[2], 10) : 0,
    deletions: statsMatch?.[3] ? Number.parseInt(statsMatch[3], 10) : 0,
  };
}

/**
 * Get diff between task branch and epic branch (WORKER only)
 */
async function getDiff(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    GetDiffInputSchema.parse(input);

    const verification = await verifyWorkerWithTask(context);
    if (!verification.success) {
      return verification.error;
    }
    const { task } = verification;

    const epic = await epicAccessor.findById(task.epicId);
    if (!epic) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Epic with ID '${task.epicId}' not found`
      );
    }

    const epicBranchName = `factoryfactory/epic-${epic.id}`;

    let diffStats: string;
    try {
      const { stdout } = await execAsync(
        `git -C "${task.worktreePath}" diff --stat ${epicBranchName}...HEAD`
      );
      diffStats = stdout;
    } catch (error) {
      return createErrorResponse(
        McpErrorCode.INTERNAL_ERROR,
        `Failed to get diff stats: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    let diffContent: string;
    try {
      const { stdout } = await execAsync(
        `git -C "${task.worktreePath}" diff ${epicBranchName}...HEAD`
      );
      diffContent = stdout;
    } catch (error) {
      return createErrorResponse(
        McpErrorCode.INTERNAL_ERROR,
        `Failed to get diff content: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const { filesChanged, insertions, deletions } = parseDiffStats(diffStats);

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
 * Attempt to rebase and return result
 */
async function attemptRebase(
  worktreePath: string,
  epicBranchName: string
): Promise<{ success: boolean; error: string; conflictFiles: string[] }> {
  try {
    await execAsync(`git -C "${worktreePath}" rebase ${epicBranchName}`);
    return { success: true, error: '', conflictFiles: [] };
  } catch (error) {
    const rebaseError = error instanceof Error ? error.message : String(error);
    let conflictFiles: string[] = [];

    try {
      const { stdout } = await execAsync(
        `git -C "${worktreePath}" diff --name-only --diff-filter=U`
      );
      conflictFiles = stdout.split('\n').filter((line) => line.trim().length > 0);
    } catch {
      // Ignore error getting conflict files
    }

    try {
      await execAsync(`git -C "${worktreePath}" rebase --abort`);
    } catch {
      // Ignore abort error
    }

    return { success: false, error: rebaseError, conflictFiles };
  }
}

/**
 * Rebase task branch onto epic branch (WORKER only)
 */
async function rebase(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    RebaseInputSchema.parse(input);

    const verification = await verifyWorkerWithTask(context);
    if (!verification.success) {
      return verification.error;
    }
    const { task } = verification;

    const epic = await epicAccessor.findById(task.epicId);
    if (!epic) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Epic with ID '${task.epicId}' not found`
      );
    }

    const epicBranchName = `factoryfactory/epic-${epic.id}`;

    try {
      await execAsync(`git -C "${task.worktreePath}" fetch origin ${epicBranchName}`);
    } catch (error) {
      return createErrorResponse(
        McpErrorCode.INTERNAL_ERROR,
        `Failed to fetch epic branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const rebaseResult = await attemptRebase(task.worktreePath, epicBranchName);

    if (!rebaseResult.success) {
      await taskAccessor.update(task.id, {
        state: TaskState.BLOCKED,
        failureReason: `Rebase conflicts: ${rebaseResult.conflictFiles.join(', ')}`,
      });

      await decisionLogAccessor.createAutomatic(context.agentId, 'mcp__git__rebase', 'error', {
        taskId: task.id,
        epicBranch: epicBranchName,
        taskBranch: task.branchName,
        conflictFiles: rebaseResult.conflictFiles,
        error: rebaseResult.error,
      });

      return createErrorResponse(McpErrorCode.INTERNAL_ERROR, 'Rebase failed with conflicts', {
        conflictFiles: rebaseResult.conflictFiles,
        error: rebaseResult.error,
      });
    }

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
