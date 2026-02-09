import { decisionLogQueryService } from '../../services/decision-log-query.service';
import { createLogger } from '../../services/logger.service';
import { CRITICAL_TOOLS, isTransientError } from './errors';
import type { McpToolContext, McpToolRegistryEntry, McpToolResponse } from './types';
import { McpErrorCode } from './types';

const logger = createLogger('mcp');

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
    logger.warn('Tool already registered, overwriting', { tool: entry.name });
  }
  toolRegistry.set(entry.name, entry);
  logger.debug('Registered MCP tool', { tool: entry.name });
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
 * Validate tool execution prerequisites
 */
function validateToolExecution(
  _agentId: string,
  toolName: string,
  timestamp: Date
):
  | { success: true; toolEntry: McpToolRegistryEntry }
  | { success: false; response: McpToolResponse } {
  const toolEntry = getTool(toolName);
  if (!toolEntry) {
    return {
      success: false,
      response: {
        success: false,
        error: {
          code: McpErrorCode.TOOL_NOT_FOUND,
          message: `Tool '${toolName}' not found in registry`,
        },
        timestamp,
      },
    };
  }

  return { success: true, toolEntry };
}

/**
 * Safely log to decision log without throwing
 */
async function safeLogToDecisionLog(
  agentId: string,
  toolName: string,
  type: 'invocation' | 'result' | 'error',
  data: unknown
): Promise<void> {
  try {
    await decisionLogQueryService.createAutomatic(agentId, toolName, type, data);
  } catch (logError) {
    logger.warn(`Failed to log tool ${type}`, {
      agentId,
      toolName,
      error: logError instanceof Error ? logError.message : String(logError),
    });
  }
}

/**
 * Execute tool with retry logic
 */
async function executeWithRetry<TInput, TOutput>(
  agentId: string,
  toolName: string,
  toolEntry: McpToolRegistryEntry,
  toolInput: TInput
): Promise<{ success: true; result: McpToolResponse<TOutput> } | { success: false; error: Error }> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const context: McpToolContext = { agentId };
      const result = await toolEntry.handler(context, toolInput);
      await safeLogToDecisionLog(agentId, toolName, 'result', result);
      return { success: true, result: result as McpToolResponse<TOutput> };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isTransientError(lastError)) {
        break;
      }
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  return { success: false, error: lastError || new Error('Unknown error') };
}

/**
 * Handle tool execution failure
 */
async function handleToolFailure(
  agentId: string,
  toolName: string,
  error: Error,
  timestamp: Date
): Promise<McpToolResponse> {
  await safeLogToDecisionLog(agentId, toolName, 'error', {
    message: error.message,
    stack: error.stack,
  });

  // Log critical tool failures
  if (CRITICAL_TOOLS.includes(toolName)) {
    logger.error('Critical tool failure', error, { toolName, agentId });
  }

  return {
    success: false,
    error: {
      code: isTransientError(error) ? McpErrorCode.TRANSIENT_ERROR : McpErrorCode.INTERNAL_ERROR,
      message: error.message,
      details: { stack: error.stack },
    },
    timestamp,
  };
}

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
    const validation = await validateToolExecution(agentId, toolName, timestamp);
    if (!validation.success) {
      return validation.response as McpToolResponse<TOutput>;
    }
    const { toolEntry } = validation;

    await safeLogToDecisionLog(agentId, toolName, 'invocation', toolInput);

    const execution = await executeWithRetry<TInput, TOutput>(
      agentId,
      toolName,
      toolEntry,
      toolInput
    );
    if (execution.success) {
      return execution.result;
    }

    return (await handleToolFailure(
      agentId,
      toolName,
      execution.error,
      timestamp
    )) as McpToolResponse<TOutput>;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      success: false,
      error: {
        code: McpErrorCode.INTERNAL_ERROR,
        message: `Unexpected error executing tool: ${err.message}`,
        details: { stack: err.stack },
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
