import type { PendingRequest } from '@/client/features/chat/reducer/types';
import {
  getPendingRequestType,
  isExitPlanModeRequest,
  type PendingRequestType,
} from '@/shared/pending-request-types';

/**
 * The kind of request the open chat is blocked on, classified like the
 * backend's session summaries so the composer and the tab agree.
 */
export function getChatPendingRequestType(
  pendingRequest: PendingRequest
): PendingRequestType | null {
  switch (pendingRequest.type) {
    case 'none':
      return null;
    case 'question':
      return isExitPlanModeRequest({ toolName: pendingRequest.request.toolName ?? '' })
        ? 'plan_approval'
        : 'user_question';
    case 'permission':
      return getPendingRequestType({
        toolName: pendingRequest.request.toolName,
        rawToolName: pendingRequest.request.rawToolName,
        input: pendingRequest.request.toolInput,
      });
  }
}
