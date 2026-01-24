import { AgentType } from '@prisma-gen/client';
import type { AgentToolPermissions, PermissionCheckResult } from './types.js';

/**
 * Tool permissions configuration for each agent type
 */
export const AGENT_TOOL_PERMISSIONS: AgentToolPermissions = {
  // Supervisor can access all tools
  [AgentType.SUPERVISOR]: {
    allowed: ['*'], // All tools
    disallowed: [], // Nothing blocked
  },

  // Orchestrator manages supervisors and system health
  [AgentType.ORCHESTRATOR]: {
    allowed: [
      'mcp__mail__*',
      'mcp__agent__*',
      'mcp__system__*',
      'mcp__task__*',
      'mcp__orchestrator__*', // Orchestrator-specific tools
    ],
    disallowed: [],
  },

  // Worker has limited permissions focused on task execution
  [AgentType.WORKER]: {
    allowed: [
      'mcp__mail__*',
      'mcp__agent__get_status',
      'mcp__agent__get_task',
      'mcp__agent__get_top_level_task',
      'mcp__system__*',
      'mcp__task__update_state',
      'mcp__task__create_pr',
      'mcp__task__get_pr_status',
      'mcp__git__*',
    ],
    disallowed: [
      'mcp__orchestrator__*',
      // Supervisor-only task management tools
      'mcp__task__create',
      'mcp__task__approve',
      'mcp__task__request_changes',
      'mcp__task__list',
      'mcp__task__get_review_queue',
      'mcp__task__force_complete',
      'mcp__task__create_final_pr',
      // Supervisor-only git tools
      'mcp__git__read_worktree_file',
    ],
  },
};

/**
 * Check if a tool name matches a pattern (supports wildcards)
 * @param toolName - The tool name to check (e.g., "mcp__mail__send")
 * @param pattern - The pattern to match against (e.g., "mcp__mail__*")
 */
export function matchPattern(toolName: string, pattern: string): boolean {
  // Convert wildcard pattern to regex
  // "*" matches any sequence of characters
  const regexPattern = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) // Escape special chars
    .join('.*');

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(toolName);
}

/**
 * Check if an agent type has permission to use a specific tool
 * @param agentType - The type of agent requesting the tool
 * @param toolName - The name of the tool being requested
 */
export function checkToolPermissions(
  agentType: AgentType,
  toolName: string
): PermissionCheckResult {
  const permissions = AGENT_TOOL_PERMISSIONS[agentType];

  // First, check if the tool is explicitly disallowed
  for (const disallowedPattern of permissions.disallowed) {
    if (matchPattern(toolName, disallowedPattern)) {
      return {
        allowed: false,
        reason: `Tool '${toolName}' is disallowed for agent type '${agentType}'`,
      };
    }
  }

  // Then, check if the tool is in the allowed list
  for (const allowedPattern of permissions.allowed) {
    if (matchPattern(toolName, allowedPattern)) {
      return {
        allowed: true,
      };
    }
  }

  // If not explicitly allowed, deny by default
  return {
    allowed: false,
    reason: `Tool '${toolName}' is not in the allowed list for agent type '${agentType}'`,
  };
}
