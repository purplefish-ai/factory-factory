/**
 * Context provided to MCP tool handlers
 */
export interface McpToolContext {
  agentId: string;
}

/**
 * Standard success response from MCP tool
 */
export interface McpToolSuccessResponse<T = unknown> {
  success: true;
  data: T;
  timestamp: Date;
}

/**
 * Standard error response from MCP tool
 */
export interface McpToolErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: Date;
}

/**
 * Union type for all MCP tool responses
 */
export type McpToolResponse<T = unknown> = McpToolSuccessResponse<T> | McpToolErrorResponse;

/**
 * Handler function signature for MCP tools
 */
export type McpToolHandler<TInput = unknown, TOutput = unknown> = (
  context: McpToolContext,
  input: TInput
) => Promise<McpToolResponse<TOutput>>;

/**
 * Tool registry entry
 */
export interface McpToolRegistryEntry {
  name: string;
  description: string;
  handler: McpToolHandler;
  schema?: unknown; // JSON schema for input validation
}

/**
 * Error codes for MCP tools
 */
export enum McpErrorCode {
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  TOOL_NOT_FOUND = 'TOOL_NOT_FOUND',
  INVALID_INPUT = 'INVALID_INPUT',
  AGENT_NOT_FOUND = 'AGENT_NOT_FOUND',
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  INVALID_AGENT_STATE = 'INVALID_AGENT_STATE',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  TRANSIENT_ERROR = 'TRANSIENT_ERROR',
  // Lock-related errors
  LOCK_NOT_AVAILABLE = 'LOCK_NOT_AVAILABLE',
  LOCK_NOT_FOUND = 'LOCK_NOT_FOUND',
  LOCK_NOT_OWNER = 'LOCK_NOT_OWNER',
  WORKSPACE_NOT_FOUND = 'WORKSPACE_NOT_FOUND',
}
