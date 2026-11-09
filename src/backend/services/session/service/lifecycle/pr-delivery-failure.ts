import { ApplicationError } from '@/backend/lib/application-error';
import { isTurnAlreadyInProgressError } from './session.error-message';

/**
 * Why a claimed background (PR) delivery did not reach the provider.
 * - `busy`: another turn holds the session; defer without spending an attempt.
 * - `resume_failed`: the exact stored conversation could not be restored.
 * - `failed`: any other failure; counts toward the bounded retry allowance.
 */
export type PRDeliveryFailureReason = 'busy' | 'resume_failed' | 'failed';

/** A failed delivery as reported to the PR delivery port; `error` is for display only. */
export interface PRDeliveryFailure {
  reason: PRDeliveryFailureReason;
  error: unknown;
}

export type PRDeliveryBlockedCause = 'busy' | 'preempted' | 'resume_failed';

const BLOCKED_MESSAGES: Record<PRDeliveryBlockedCause, string> = {
  busy: 'A turn is already in progress for this session',
  preempted: 'Turn in progress: human message queued during preparation',
  resume_failed: 'Required existing conversation could not be restored',
};

/** Typed session-side error for a background delivery that dispatch could not start. */
export function createPRDeliveryBlockedError(cause: PRDeliveryBlockedCause): ApplicationError {
  return cause === 'resume_failed'
    ? createResumeFailedError()
    : new ApplicationError('CONFLICT', BLOCKED_MESSAGES[cause], { kind: 'SESSION_TURN_BUSY' });
}

/** Typed error for a required existing provider conversation that failed to resume. */
export function createResumeFailedError(): ApplicationError {
  return new ApplicationError('PRECONDITION_FAILED', BLOCKED_MESSAGES.resume_failed, {
    kind: 'SESSION_RESUME_FAILED',
  });
}

/**
 * Classifies a delivery failure by its typed kind, never by our own message text.
 * Provider runtimes report a busy prompt slot only through their error payload;
 * that external contract stays owned by `isTurnAlreadyInProgressError`.
 */
export function classifyPRDeliveryFailure(error: unknown): PRDeliveryFailure {
  return { reason: classifyReason(error), error };
}

function classifyReason(error: unknown): PRDeliveryFailureReason {
  if (error instanceof ApplicationError) {
    if (error.kind === 'SESSION_TURN_BUSY') {
      return 'busy';
    }
    if (error.kind === 'SESSION_RESUME_FAILED') {
      return 'resume_failed';
    }
    return 'failed';
  }
  return isTurnAlreadyInProgressError(error) ? 'busy' : 'failed';
}
