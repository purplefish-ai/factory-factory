import { z } from "zod";
import { decisionLogAccessor } from "../../resource_accessors/index.js";
import {
  McpToolContext,
  McpToolResponse,
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

const LogDecisionInputSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Manually log a decision or business logic event
 */
async function logDecision(
  context: McpToolContext,
  input: unknown
): Promise<McpToolResponse> {
  try {
    const parsed = LogDecisionInputSchema.parse(input);
    const { title, body } = parsed;

    const log = await decisionLogAccessor.createManual(
      context.agentId,
      title,
      body
    );

    return createSuccessResponse({
      logId: log.id,
      timestamp: log.timestamp,
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

export function registerSystemTools(): void {
  registerMcpTool({
    name: "mcp__system__log_decision",
    description: "Manually log a decision or business logic event",
    handler: logDecision,
    schema: LogDecisionInputSchema,
  });
}
