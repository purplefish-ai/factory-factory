import type { Task } from '@prisma-gen/client';
import { AgentType } from '@prisma-gen/client';
import { z } from 'zod';
import { agentAccessor, taskAccessor } from '../../resource_accessors/index.js';
import { createErrorResponse, createSuccessResponse, registerMcpTool } from './server.js';
import type { McpToolContext, McpToolResponse } from './types.js';
import { McpErrorCode } from './types.js';

// ============================================================================
// Input Schemas
// ============================================================================

const GetStatusInputSchema = z.object({});
const GetTaskInputSchema = z.object({});
const GetTopLevelTaskInputSchema = z.object({});

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Get the current agent's status
 */
async function getStatus(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    GetStatusInputSchema.parse(input);

    const agent = await agentAccessor.findById(context.agentId);

    if (!agent) {
      return createErrorResponse(
        McpErrorCode.AGENT_NOT_FOUND,
        `Agent with ID '${context.agentId}' not found`
      );
    }

    return createSuccessResponse({
      id: agent.id,
      type: agent.type,
      state: agent.state,
      currentTaskId: agent.currentTaskId,
      tmuxSessionName: agent.tmuxSessionName,
      lastActiveAt: agent.lastActiveAt,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

/**
 * Get the current agent's task (WORKER only)
 */
async function getTask(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    GetTaskInputSchema.parse(input);

    const agent = await agentAccessor.findById(context.agentId);

    if (!agent) {
      return createErrorResponse(
        McpErrorCode.AGENT_NOT_FOUND,
        `Agent with ID '${context.agentId}' not found`
      );
    }

    // Verify agent is a WORKER
    if (agent.type !== AgentType.WORKER) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Only WORKER agents can get task details'
      );
    }

    // Get the task
    if (!agent.currentTaskId) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Agent does not have a current task assigned'
      );
    }

    const task = await taskAccessor.findById(agent.currentTaskId);

    if (!task) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Task with ID '${agent.currentTaskId}' not found`
      );
    }

    return createSuccessResponse({
      id: task.id,
      title: task.title,
      description: task.description,
      state: task.state,
      parentId: task.parentId,
      worktreePath: task.worktreePath,
      branchName: task.branchName,
      prUrl: task.prUrl,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(McpErrorCode.INVALID_INPUT, 'Invalid input', error.issues);
    }
    throw error;
  }
}

/**
 * Get the current agent's top-level task (the root parent task)
 */
async function getTopLevelTask(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    GetTopLevelTaskInputSchema.parse(input);

    const agent = await agentAccessor.findById(context.agentId);

    if (!agent) {
      return createErrorResponse(
        McpErrorCode.AGENT_NOT_FOUND,
        `Agent with ID '${context.agentId}' not found`
      );
    }

    // Verify agent is SUPERVISOR, ORCHESTRATOR, or WORKER
    if (
      agent.type !== AgentType.SUPERVISOR &&
      agent.type !== AgentType.ORCHESTRATOR &&
      agent.type !== AgentType.WORKER
    ) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Agent type does not have top-level task access'
      );
    }

    if (!agent.currentTaskId) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        'Agent does not have a current task assigned'
      );
    }

    let topLevelTask: Task | null;

    // Get top-level task based on agent type
    if (agent.type === AgentType.SUPERVISOR || agent.type === AgentType.ORCHESTRATOR) {
      // For supervisor/orchestrator, currentTaskId is already the top-level task
      topLevelTask = await taskAccessor.findById(agent.currentTaskId);
    } else {
      // For workers, traverse up to find the root parent
      topLevelTask = await taskAccessor.getTopLevelParent(agent.currentTaskId);
    }

    if (!topLevelTask) {
      return createErrorResponse(McpErrorCode.RESOURCE_NOT_FOUND, 'Top-level task not found');
    }

    return createSuccessResponse({
      id: topLevelTask.id,
      title: topLevelTask.title,
      description: topLevelTask.description,
      state: topLevelTask.state,
      linearIssueId: topLevelTask.linearIssueId,
      linearIssueUrl: topLevelTask.linearIssueUrl,
      createdAt: topLevelTask.createdAt,
      updatedAt: topLevelTask.updatedAt,
      completedAt: topLevelTask.completedAt,
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

export function registerAgentTools(): void {
  registerMcpTool({
    name: 'mcp__agent__get_status',
    description: "Get the current agent's status and metadata",
    handler: getStatus,
    schema: GetStatusInputSchema,
  });

  registerMcpTool({
    name: 'mcp__agent__get_task',
    description: "Get the current agent's task details (WORKER only)",
    handler: getTask,
    schema: GetTaskInputSchema,
  });

  registerMcpTool({
    name: 'mcp__agent__get_top_level_task',
    description: "Get the current agent's top-level task (the root parent task in the hierarchy)",
    handler: getTopLevelTask,
    schema: GetTopLevelTaskInputSchema,
  });
}
