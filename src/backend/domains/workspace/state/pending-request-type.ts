export type WorkspacePendingRequestType = 'plan_approval' | 'user_question' | null;

/**
 * Determine the pending request type for a workspace based on its active sessions.
 * Returns 'plan_approval' if any session has a pending ExitPlanMode request,
 * 'user_question' if any session has a pending AskUserQuestion request,
 * or null if no pending requests.
 */
export function computePendingRequestType(
  sessionIds: string[],
  pendingRequests: Map<string, { toolName: string }>
): WorkspacePendingRequestType {
  for (const sessionId of sessionIds) {
    const request = pendingRequests.get(sessionId);
    if (!request) {
      continue;
    }

    if (request.toolName === 'ExitPlanMode') {
      return 'plan_approval';
    }
    if (request.toolName === 'AskUserQuestion') {
      return 'user_question';
    }
  }

  return null;
}
