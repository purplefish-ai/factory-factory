import { agentAccessor, decisionLogAccessor } from "../../resource_accessors/index.js";
import { checkToolPermissions } from "./permissions.js";
import {
  McpToolContext,
  McpToolRegistryEntry,
  McpToolResponse,
  McpErrorCode,
} from "./types.js";
import {
  CRITICAL_TOOLS,
  escalateCriticalError,
  escalateToolFailure,
  isTransientError,
} from "./errors.js";

/**
 * Global tool registry
 * Maps tool name to handler function and metadata
 */
const toolRegistry = new Map<string, McpToolRegistryEntry>();

/**
 * Register an MCP tool
 */
export function registerMcpTool(entry: McpToolRegistryEntry): void {
  if (toolRegistry.has(entry.name)) {
    console.warn(`Tool '${entry.name}' is already registered. Overwriting.`);
  }
  toolRegistry.set(entry.name, entry);
  console.log(`Registered MCP tool: ${entry.name}`);
}

/**
 * Get all registered tools
 */
export function getRegisteredTools(): McpToolRegistryEntry[] {
  return Array.from(toolRegistry.values());
}

/**
 * Get a specific tool by name
 */
export function getTool(toolName: string): McpToolRegistryEntry | undefined {
  return toolRegistry.get(toolName);
}

/**
 * Maximum number of retries for transient errors
 */
const MAX_RETRIES = 3;

/**
 * Retry delay in milliseconds
 */
const RETRY_DELAY_MS = 1000;

/**
 * Execute an MCP tool with full lifecycle management
 */
export async function executeMcpTool<TInput = unknown, TOutput = unknown>(
  agentId: string,
  toolName: string,
  toolInput: TInput
): Promise<McpToolResponse<TOutput>> {
  const timestamp = new Date();

  try {
    // 1. Fetch agent from database
    const agent = await agentAccessor.findById(agentId);
    if (!agent) {
      return {
        success: false,
        error: {
          code: McpErrorCode.AGENT_NOT_FOUND,
          message: `Agent with ID '${agentId}' not found`,
        },
        timestamp,
      };
    }

    // 2. Check if tool exists
    const toolEntry = getTool(toolName);
    if (!toolEntry) {
      return {
        success: false,
        error: {
          code: McpErrorCode.TOOL_NOT_FOUND,
          message: `Tool '${toolName}' not found in registry`,
        },
        timestamp,
      };
    }

    // 3. Check tool permissions
    const permissionCheck = checkToolPermissions(agent.type, toolName);
    if (!permissionCheck.allowed) {
      return {
        success: false,
        error: {
          code: McpErrorCode.PERMISSION_DENIED,
          message: permissionCheck.reason || "Permission denied",
        },
        timestamp,
      };
    }

    // 4. Log tool invocation
    await decisionLogAccessor.createAutomatic(
      agentId,
      toolName,
      "invocation",
      toolInput
    );

    // 5. Execute tool with retry logic
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const context: McpToolContext = { agentId };
        const result = await toolEntry.handler(context, toolInput);

        // 6. Log tool result
        await decisionLogAccessor.createAutomatic(
          agentId,
          toolName,
          "result",
          result
        );

        // 7. Update agent lastActiveAt on successful tool call
        await agentAccessor.update(agentId, {
          lastActiveAt: new Date(),
        });

        return result as McpToolResponse<TOutput>;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Only retry on transient errors
        if (!isTransientError(lastError)) {
          break;
        }

        // Wait before retrying
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }

    // 8. Handle error after retries exhausted
    const error = lastError || new Error("Unknown error");

    // Log error
    await decisionLogAccessor.createAutomatic(agentId, toolName, "error", {
      message: error.message,
      stack: error.stack,
    });

    // Escalate based on criticality
    if (CRITICAL_TOOLS.includes(toolName)) {
      await escalateCriticalError(agent, toolName, error);
    } else {
      await escalateToolFailure(agent, toolName, error);
    }

    return {
      success: false,
      error: {
        code: isTransientError(error)
          ? McpErrorCode.TRANSIENT_ERROR
          : McpErrorCode.INTERNAL_ERROR,
        message: error.message,
        details: {
          stack: error.stack,
        },
      },
      timestamp,
    };
  } catch (error) {
    // Catch-all for unexpected errors in the execution pipeline
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      success: false,
      error: {
        code: McpErrorCode.INTERNAL_ERROR,
        message: `Unexpected error executing tool: ${err.message}`,
        details: {
          stack: err.stack,
        },
      },
      timestamp,
    };
  }
}

/**
 * Helper function to create a success response
 */
export function createSuccessResponse<T>(data: T): McpToolResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date(),
  };
}

/**
 * Helper function to create an error response
 */
export function createErrorResponse(
  code: McpErrorCode,
  message: string,
  details?: unknown
): McpToolResponse<never> {
  return {
    success: false,
    error: {
      code,
      message,
      details,
    },
    timestamp: new Date(),
  };
}
