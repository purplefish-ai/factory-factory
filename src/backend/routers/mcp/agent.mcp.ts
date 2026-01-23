import { z } from "zod";
import { AgentType } from "@prisma/client";
import {
  agentAccessor,
  taskAccessor,
  epicAccessor,
} from "../../resource_accessors/index.js";
import type {
  McpToolContext,
  McpToolResponse} from "./types.js";
import {
  McpErrorCode,
} from "./types.js";
import {
  registerMcpTool,
  createSuccessResponse,
  createErrorResponse,
} from "./server.js";

// ============================================================================
// Input Schemas
// ============================================================================

const GetStatusInputSchema = z.object({});
const GetTaskInputSchema = z.object({});
const GetEpicInputSchema = z.object({});

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Get the current agent's status
 */
async function getStatus(
  context: McpToolContext,
  input: unknown
): Promise<McpToolResponse> {
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
      currentEpicId: agent.currentEpicId,
      currentTaskId: agent.currentTaskId,
      tmuxSessionName: agent.tmuxSessionName,
      lastActiveAt: agent.lastActiveAt,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(
        McpErrorCode.INVALID_INPUT,
        "Invalid input",
        error.errors
      );
    }
    throw error;
  }
}

/**
 * Get the current agent's task (WORKER only)
 */
async function getTask(
  context: McpToolContext,
  input: unknown
): Promise<McpToolResponse> {
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
        "Only WORKER agents can get task details"
      );
    }

    // Get the task
    if (!agent.currentTaskId) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        "Agent does not have a current task assigned"
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
      epicId: task.epicId,
      worktreePath: task.worktreePath,
      branchName: task.branchName,
      prUrl: task.prUrl,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(
        McpErrorCode.INVALID_INPUT,
        "Invalid input",
        error.errors
      );
    }
    throw error;
  }
}

/**
 * Get the current agent's epic (SUPERVISOR or WORKER)
 */
async function getEpic(
  context: McpToolContext,
  input: unknown
): Promise<McpToolResponse> {
  try {
    GetEpicInputSchema.parse(input);

    const agent = await agentAccessor.findById(context.agentId);

    if (!agent) {
      return createErrorResponse(
        McpErrorCode.AGENT_NOT_FOUND,
        `Agent with ID '${context.agentId}' not found`
      );
    }

    // Verify agent is SUPERVISOR or WORKER
    if (
      agent.type !== AgentType.SUPERVISOR &&
      agent.type !== AgentType.ORCHESTRATOR &&
      agent.type !== AgentType.WORKER
    ) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        "Agent type does not have epic access"
      );
    }

    let epicId: string | null = null;

    // Get epic ID based on agent type
    if (
      agent.type === AgentType.SUPERVISOR ||
      agent.type === AgentType.ORCHESTRATOR
    ) {
      epicId = agent.currentEpicId;
    } else if (agent.type === AgentType.WORKER) {
      // For workers, get epic via task
      if (!agent.currentTaskId) {
        return createErrorResponse(
          McpErrorCode.INVALID_AGENT_STATE,
          "Worker does not have a current task assigned"
        );
      }

      const task = await taskAccessor.findById(agent.currentTaskId);
      if (!task) {
        return createErrorResponse(
          McpErrorCode.RESOURCE_NOT_FOUND,
          `Task with ID '${agent.currentTaskId}' not found`
        );
      }

      epicId = task.epicId;
    }

    if (!epicId) {
      return createErrorResponse(
        McpErrorCode.INVALID_AGENT_STATE,
        "Agent does not have a current epic"
      );
    }

    const epic = await epicAccessor.findById(epicId);

    if (!epic) {
      return createErrorResponse(
        McpErrorCode.RESOURCE_NOT_FOUND,
        `Epic with ID '${epicId}' not found`
      );
    }

    return createSuccessResponse({
      id: epic.id,
      linearIssueId: epic.linearIssueId,
      linearIssueUrl: epic.linearIssueUrl,
      title: epic.title,
      description: epic.description,
      state: epic.state,
      createdAt: epic.createdAt,
      updatedAt: epic.updatedAt,
      completedAt: epic.completedAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(
        McpErrorCode.INVALID_INPUT,
        "Invalid input",
        error.errors
      );
    }
    throw error;
  }
}

// ============================================================================
// Tool Registration
// ============================================================================

export function registerAgentTools(): void {
  registerMcpTool({
    name: "mcp__agent__get_status",
    description: "Get the current agent's status and metadata",
    handler: getStatus,
    schema: GetStatusInputSchema,
  });

  registerMcpTool({
    name: "mcp__agent__get_task",
    description: "Get the current agent's task details (WORKER only)",
    handler: getTask,
    schema: GetTaskInputSchema,
  });

  registerMcpTool({
    name: "mcp__agent__get_epic",
    description: "Get the current agent's epic details",
    handler: getEpic,
    schema: GetEpicInputSchema,
  });
}
