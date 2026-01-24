/**
 * Shared helper functions for MCP tools
 */
import type { Agent } from '@prisma-gen/client';
import { AgentType } from '@prisma-gen/client';
import { agentAccessor } from '../../resource_accessors/index.js';
import { createErrorResponse } from './server.js';
import type { McpToolContext, McpToolResponse } from './types.js';
import { McpErrorCode } from './types.js';

interface VerifyAgentOptions {
  /** Required agent type */
  requiredType: AgentType;
  /** Error message for wrong type */
  typeErrorMessage: string;
  /** Whether to require a current task */
  requireTask?: boolean;
  /** Error message for missing task */
  taskErrorMessage?: string;
}

type VerifyAgentSuccess = { success: true; agent: Agent; currentTaskId: string | null };
type VerifyAgentFailure = { success: false; error: McpToolResponse };

/**
 * Generic agent verification helper
 */
export async function verifyAgent(
  context: McpToolContext,
  options: VerifyAgentOptions
): Promise<VerifyAgentSuccess | VerifyAgentFailure> {
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

  if (agent.type !== options.requiredType) {
    return {
      success: false,
      error: createErrorResponse(McpErrorCode.PERMISSION_DENIED, options.typeErrorMessage),
    };
  }

  if (options.requireTask && !agent.currentTaskId) {
    return {
      success: false,
      error: createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        options.taskErrorMessage ?? 'Agent does not have a task assigned'
      ),
    };
  }

  return { success: true, agent, currentTaskId: agent.currentTaskId };
}

/**
 * Verify agent is a SUPERVISOR with a top-level task assigned
 */
export async function verifySupervisorWithTopLevelTask(
  context: McpToolContext
): Promise<
  | { success: true; agentId: string; topLevelTaskId: string }
  | { success: false; error: McpToolResponse }
> {
  const result = await verifyAgent(context, {
    requiredType: AgentType.SUPERVISOR,
    typeErrorMessage: 'Only SUPERVISOR agents can use these task management tools',
    requireTask: true,
    taskErrorMessage: 'Supervisor does not have a top-level task assigned',
  });

  if (!result.success) {
    return result;
  }

  // currentTaskId is guaranteed by requireTask: true
  return {
    success: true,
    agentId: result.agent.id,
    topLevelTaskId: result.currentTaskId as string,
  };
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
