/**
 * Shared helper functions for MCP tools
 */
import { AgentType } from '@prisma-gen/client';
import { agentAccessor } from '../../resource_accessors/index.js';
import { createErrorResponse } from './server.js';
import type { McpToolContext, McpToolResponse } from './types.js';
import { McpErrorCode } from './types.js';

/**
 * Verify agent is a SUPERVISOR with a top-level task assigned
 */
export async function verifySupervisorWithTopLevelTask(
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
 * Generate worktree name for a top-level task
 */
export function getTopLevelTaskWorktreeName(taskId: string): string {
  return `top-level-${taskId.substring(0, 8)}`;
}

/**
 * Generate branch name for a top-level task
 */
export function getTopLevelTaskBranchName(taskId: string): string {
  return `factoryfactory/task-${taskId.substring(0, 8)}`;
}

/**
 * Generate worktree name for a subtask
 */
export function getSubtaskWorktreeName(taskId: string, title: string): string {
  const sanitizedTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .substring(0, 30)
    .replace(/-+$/, '');
  return `task-${taskId.substring(0, 8)}-${sanitizedTitle}`;
}

/**
 * Generate a local issue ID for tasks not linked to Linear
 */
export function generateLocalIssueId(): string {
  return `local-${Date.now()}`;
}
