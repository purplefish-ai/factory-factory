/**
 * Shared types for pending interactive requests.
 * Used by both frontend and backend for session restore functionality.
 */

/**
 * Tool names that support using a message as an interactive response.
 * - AskUserQuestion: User can respond with free-form text (treated as "Other" option)
 * - ExitPlanMode: User can deny with feedback text
 */
export const INTERACTIVE_RESPONSE_TOOLS = ['AskUserQuestion', 'ExitPlanMode'] as const;

/**
 * Type for interactive response tool names.
 */
export type InteractiveResponseTool = (typeof INTERACTIVE_RESPONSE_TOOLS)[number];

/**
 * Runtime guard for tool names that support frontend interactive-response routing.
 */
export function isInteractiveResponseTool(toolName: string): toolName is InteractiveResponseTool {
  return (INTERACTIVE_RESPONSE_TOOLS as readonly string[]).includes(toolName);
}

/**
 * Pending interactive request stored for session restore.
 * When a user navigates away and returns, we need to restore the modal.
 */
export interface PendingInteractiveRequest {
  requestId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  /** Plan content for ExitPlanMode requests */
  planContent: string | null;
  /** ACP permission options for resolving pending requests after reconnect. */
  acpOptions?: Array<{
    optionId: string;
    name: string;
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  }>;
  timestamp: string;
}
