import type {
  SessionCommandError,
  SessionCommandOutcome,
  SessionDomainService,
} from '@/backend/services/session';

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
    case 'set_config_option_failed':
      return `Failed to set config option: ${getErrorMessage(error.cause)}`;
    default: {
      const detail = error.cause instanceof Error ? error.cause.message : String(error.cause);
      switch (error.kind) {
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

/** Adapt requester outcomes while keeping session-wide correction delivery on the domain event bus. */
export function applySessionCommandOutcome(
  requester: { send(payload: string): void },
  sessionId: string | null,
  outcome: SessionCommandOutcome | undefined,
  domain: Pick<SessionDomainService, 'emitDelta'>
): void {
  if (!outcome) {
    return;
  }
  for (const reply of outcome.replies) {
    if (reply.type === 'error') {
      requester.send(JSON.stringify({ type: 'error', message: formatCommandError(reply.error) }));
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
  if (sessionId && outcome.configOptionsCorrection) {
    domain.emitDelta(sessionId, {
      type: 'config_options_update',
      configOptions: outcome.configOptionsCorrection,
    });
  }
}
