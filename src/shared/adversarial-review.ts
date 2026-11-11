/**
 * Shared between the adversarial-review orchestrator (which posts the marker)
 * and the ratchet domain (which recognizes it as actionable feedback),
 * without either importing the other.
 */

import { SessionStatus } from './core';

export const ADVERSARIAL_REVIEW_WORKFLOW = 'adversarial_review';

export const ADVERSARIAL_REVIEW_MARKER = '<!-- factory-factory:adversarial-review -->';

/** Whether a PR review or comment body was authored by the adversarial-review feature. */
export function hasAdversarialReviewMarker(body: string | null | undefined): boolean {
  return typeof body === 'string' && body.includes(ADVERSARIAL_REVIEW_MARKER);
}

/**
 * A finished review keeps its session for the transcript. Stopping persists
 * IDLE, so it holds no reviewer and doesn't use a workspace session slot. A
 * review created but not yet started has no provider session and still counts,
 * so concurrent creations can't overshoot the limit. The session accessor's
 * limit query mirrors this.
 */
export function isFinishedAdversarialReview(session: {
  workflow?: string | null;
  status: SessionStatus;
  providerSessionId?: string | null;
}): boolean {
  return (
    session.workflow === ADVERSARIAL_REVIEW_WORKFLOW &&
    session.status === SessionStatus.IDLE &&
    Boolean(session.providerSessionId)
  );
}
