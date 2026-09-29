/**
 * Shared types for pending interactive requests.
 * Used by both frontend and backend for session restore functionality.
 */

/**
 * Returns true when the tool input looks like AskUserQuestion input.
 * This supports adapters that map question prompts to a non-standard tool name.
 */
export function hasAskUserQuestionInput(
  input: Record<string, unknown> | null | undefined
): boolean {
  if (!input) {
    return false;
  }
  const questions = input.questions;
  return Array.isArray(questions);
}

/**
 * Returns true when the tool input identifies an ACP ExitPlanMode request.
 * ACP tool titles are display labels, so request classification should prefer
 * the stable input type when it is present.
 */
export function hasExitPlanModeInput(input: Record<string, unknown> | null | undefined): boolean {
  return input?.type === 'ExitPlanMode';
}

/**
 * Returns true when a pending request should be treated as plan approval.
 */
export function isExitPlanModeRequest(
  request: Pick<PendingInteractiveRequest, 'toolName'> & {
    input?: Record<string, unknown>;
  }
): boolean {
  return request.toolName === 'ExitPlanMode' || hasExitPlanModeInput(request.input);
}

/**
 * Returns true when a pending request should be treated as a user-question prompt.
 */
export function isUserQuestionRequest(
  request: Pick<PendingInteractiveRequest, 'toolName'> & {
    input?: Record<string, unknown>;
  }
): boolean {
  return request.toolName === 'AskUserQuestion' || hasAskUserQuestionInput(request.input);
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
