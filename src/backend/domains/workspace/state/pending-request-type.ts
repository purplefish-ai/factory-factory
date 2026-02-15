import { isUserQuestionRequest } from '@/shared/pending-request-types';

export type WorkspacePendingRequestType =
  | 'plan_approval'
  | 'user_question'
  | 'permission_request'
  | null;

/**
 * Determine the pending request type for a workspace based on its active sessions.
 * Returns 'plan_approval' if any session has a pending ExitPlanMode request,
 * 'user_question' if any session has a pending AskUserQuestion request (or a
 * request payload that contains `questions`),
 * 'permission_request' for any other pending modal permission request,
 * or null if no pending requests.
 */
export function computePendingRequestType(
  sessionIds: string[],
  pendingRequests: Map<string, { toolName: string; input?: Record<string, unknown> }>
): WorkspacePendingRequestType {
  let hasUserQuestion = false;
  let hasPermissionRequest = false;

  for (const sessionId of sessionIds) {
    const request = pendingRequests.get(sessionId);
    if (!request) {
      continue;
    }

    if (request.toolName === 'ExitPlanMode') {
      return 'plan_approval';
    }
    if (isUserQuestionRequest({ toolName: request.toolName, input: request.input })) {
      hasUserQuestion = true;
      continue;
    }
    hasPermissionRequest = true;
  }

  if (hasUserQuestion) {
    return 'user_question';
  }
  if (hasPermissionRequest) {
    return 'permission_request';
  }

  return null;
}
