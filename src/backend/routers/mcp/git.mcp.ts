import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AgentType, TaskState } from '@prisma-gen/client';
import { z } from 'zod';
import { gitCommand } from '../../lib/shell.js';
import {
  agentAccessor,
  decisionLogAccessor,
  taskAccessor,
} from '../../resource_accessors/index.js';
import { createErrorResponse, createSuccessResponse, registerMcpTool } from './server.js';
import type { McpToolContext, McpToolResponse } from './types.js';
import { McpErrorCode } from './types.js';

// ============================================================================
// Input Schemas
// ============================================================================

const GetDiffInputSchema = z.object({});

const RebaseInputSchema = z.object({});

const ReadWorktreeFileInputSchema = z.object({
  taskId: z.string().min(1, 'Task ID is required'),
  filePath: z.string().min(1, 'File path is required'),
});

// ============================================================================
// Helper Functions
// ============================================================================

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
        'Only SUPERVISOR agents can use this tool'
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
 * Verify worker agent and get task context
 */
async function verifyWorkerWithTask(context: McpToolContext): Promise<
  | {
      success: true;
      task: { id: string; worktreePath: string; branchName: string; parentId: string | null };
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
      parentId: task.parentId,
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
 * Get diff between task branch and parent task (epic) branch (WORKER only)
 */
async function getDiff(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    GetDiffInputSchema.parse(input);

    const verification = await verifyWorkerWithTask(context);
    if (!verification.success) {
      return verification.error;
    }
    const { task } = verification;

    if (!task.parentId) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Task does not have a parent task'
      );
    }

    const parentTask = await taskAccessor.findById(task.parentId);
    if (!parentTask) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Parent task with ID '${task.parentId}' not found`
      );
    }

    const topLevelBranchName = `factoryfactory/task-${parentTask.id.substring(0, 8)}`;

    let diffStats: string;
    try {
      // Using spawn with array args (safe - no shell interpretation)
      const result = await gitCommand(
        ['diff', '--stat', `${topLevelBranchName}...HEAD`],
        task.worktreePath
      );
      diffStats = result.stdout;
    } catch (error) {
      return createErrorResponse(
        McpErrorCode.INTERNAL_ERROR,
        `Failed to get diff stats: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    let diffContent: string;
    try {
      const result = await gitCommand(['diff', `${topLevelBranchName}...HEAD`], task.worktreePath);
      diffContent = result.stdout;
    } catch (error) {
      return createErrorResponse(
        McpErrorCode.INTERNAL_ERROR,
        `Failed to get diff content: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const { filesChanged, insertions, deletions } = parseDiffStats(diffStats);

    await decisionLogAccessor.createAutomatic(context.agentId, 'mcp__git__get_diff', 'result', {
      taskId: task.id,
      epicBranch: topLevelBranchName,
      taskBranch: task.branchName,
      filesChanged,
      insertions,
      deletions,
    });

    return createSuccessResponse({
      taskId: task.id,
      epicBranch: topLevelBranchName,
      taskBranch: task.branchName,
      filesChanged,
      insertions,
      deletions,
      stats: diffStats,
      diff: diffContent,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

/**
 * Attempt to rebase and return result
 */
async function attemptRebase(
  worktreePath: string,
  topLevelBranchName: string
): Promise<{ success: boolean; error: string; conflictFiles: string[] }> {
  try {
    await gitCommand(['rebase', topLevelBranchName], worktreePath);
    return { success: true, error: '', conflictFiles: [] };
  } catch (error) {
    const rebaseError = error instanceof Error ? error.message : String(error);
    let conflictFiles: string[] = [];

    try {
      const { stdout } = await gitCommand(['diff', '--name-only', '--diff-filter=U'], worktreePath);
      conflictFiles = stdout.split('\n').filter((line) => line.trim().length > 0);
    } catch {
      // Ignore error getting conflict files
    }

    try {
      await gitCommand(['rebase', '--abort'], worktreePath);
    } catch {
      // Ignore abort error
    }

    return { success: false, error: rebaseError, conflictFiles };
  }
}

/**
 * Rebase task branch onto parent task (epic) branch (WORKER only)
 */
async function rebase(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    RebaseInputSchema.parse(input);

    const verification = await verifyWorkerWithTask(context);
    if (!verification.success) {
      return verification.error;
    }
    const { task } = verification;

    if (!task.parentId) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Task does not have a parent task'
      );
    }

    const parentTask = await taskAccessor.findById(task.parentId);
    if (!parentTask) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Parent task with ID '${task.parentId}' not found`
      );
    }

    const topLevelBranchName = `factoryfactory/task-${parentTask.id.substring(0, 8)}`;

    try {
      // Fetch using spawn (safe)
      await gitCommand(['fetch', 'origin', topLevelBranchName], task.worktreePath);
    } catch (error) {
      return createErrorResponse(
        McpErrorCode.INTERNAL_ERROR,
        `Failed to fetch epic branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const rebaseResult = await attemptRebase(task.worktreePath, topLevelBranchName);

    if (!rebaseResult.success) {
      await taskAccessor.update(task.id, {
        state: TaskState.BLOCKED,
        failureReason: `Rebase conflicts: ${rebaseResult.conflictFiles.join(', ')}`,
      });

      await decisionLogAccessor.createAutomatic(context.agentId, 'mcp__git__rebase', 'error', {
        taskId: task.id,
        epicBranch: topLevelBranchName,
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
      // Push using spawn (safe)
      await gitCommand(
        ['push', '--force-with-lease', 'origin', task.branchName],
        task.worktreePath
      );
    } catch (error) {
      return createErrorResponse(
        McpErrorCode.INTERNAL_ERROR,
        `Failed to push rebased branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    await decisionLogAccessor.createAutomatic(context.agentId, 'mcp__git__rebase', 'result', {
      taskId: task.id,
      epicBranch: topLevelBranchName,
      taskBranch: task.branchName,
      success: true,
    });

    return createSuccessResponse({
      taskId: task.id,
      epicBranch: topLevelBranchName,
      taskBranch: task.branchName,
      success: true,
      message: 'Rebase completed successfully and branch force-pushed',
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
async function readWorktreeFile(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const validatedInput = ReadWorktreeFileInputSchema.parse(input);

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
      'mcp__git__read_worktree_file',
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
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
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

  registerMcpTool({
    name: 'mcp__git__read_worktree_file',
    description: "Read a file from a worker's worktree for code review (SUPERVISOR only)",
    handler: readWorktreeFile,
    schema: ReadWorktreeFileInputSchema,
  });
}
