import type { SessionCommandError, SessionCommandOutcome } from '@/backend/services/session';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as { message?: unknown; code?: unknown; data?: unknown };
    if (typeof candidate.message === 'string' && candidate.message.length > 0) {
      return candidate.message;
    }
    if (typeof candidate.data !== 'undefined') {
      try {
        return JSON.stringify(candidate.data);
      } catch {
        // Fall through to generic object serialization
      }
    }
    if (typeof candidate.code === 'number' || typeof candidate.code === 'string') {
      return `ACP error (${String(candidate.code)})`;
    }
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function formatCommandError(error: SessionCommandError): string {
  switch (error.kind) {
    case 'no_session':
      return 'No session selected. Please create or select a session first.';
    case 'permission_not_pending':
      return 'No pending ACP permission request found for this request ID';
    case 'session_not_found':
      return 'Session not found';
    case 'workspace_archived':
      return 'Workspace is archived or archiving and cannot start sessions.';
    case 'no_active_session':
      return 'No active session. Use queue_message to queue messages.';
    case 'background_monitoring_required':
      return 'Disable PR updates to cancel background monitoring';
    case 'message_not_queued':
      return 'Message not found in queue';
    case 'queue_input_invalid':
      return error.reason;
    case 'set_config_option_failed':
      return `Failed to set config option: ${getErrorMessage(error.cause)}`;
    default: {
      const detail = error.cause instanceof Error ? error.cause.message : String(error.cause);
      switch (error.kind) {
        case 'steer_failed':
          return `Failed to steer message; it remains queued: ${detail}`;
        case 'start_failed':
          return `Failed to start agent: ${detail}`;
        case 'set_model_failed':
          return `Failed to set model: ${detail}`;
        case 'set_thinking_budget_failed':
          return `Failed to set thinking budget: ${detail}`;
        case 'permission_response_failed':
          return `Failed to respond to permission: ${detail}`;
      }
    }
  }
}

/** Format requester outcomes; configuration publication belongs to the serialized service. */
export function applySessionCommandOutcome(
  requester: { send(payload: string): void },
  outcome: SessionCommandOutcome | undefined
): void {
  if (!outcome) {
    return;
  }
  for (const reply of outcome.replies) {
    if (reply.type === 'error') {
      requester.send(
        JSON.stringify({
          type: 'error',
          ...(reply.requestId !== undefined ? { requestId: reply.requestId } : {}),
          message: formatCommandError(reply.error),
        })
      );
    } else {
      try {
        requester.send(JSON.stringify(reply));
      } catch (cause) {
        requester.send(
          JSON.stringify({
            type: 'error',
            message: formatCommandError({ kind: 'set_model_failed', cause }),
          })
        );
      }
    }
  }
}
