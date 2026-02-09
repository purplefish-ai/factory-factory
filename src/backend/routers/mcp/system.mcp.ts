import { z } from 'zod';
import { decisionLogQueryService } from '../../services/decision-log-query.service';
import { createErrorResponse, createSuccessResponse, registerMcpTool } from './server';
import type { McpToolContext, McpToolResponse } from './types';
import { McpErrorCode } from './types';

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
async function logDecision(context: McpToolContext, input: unknown): Promise<McpToolResponse> {
  try {
    const parsed = LogDecisionInputSchema.parse(input);
    const { title, body } = parsed;

    const log = await decisionLogQueryService.createManual(context.agentId, title, body);

    return createSuccessResponse({
      logId: log.id,
      timestamp: log.timestamp,
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

export function registerSystemTools(): void {
  registerMcpTool({
    name: 'mcp__system__log_decision',
    description: 'Manually log a decision or business logic event',
    handler: logDecision,
    schema: LogDecisionInputSchema,
  });
}
