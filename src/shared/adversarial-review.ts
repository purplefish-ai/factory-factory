/**
 * Shared between the adversarial-review orchestrator (which posts the marker)
 * and the ratchet domain (which recognizes it as actionable feedback),
 * without either importing the other.
 */

export const ADVERSARIAL_REVIEW_WORKFLOW = 'adversarial_review';

export const ADVERSARIAL_REVIEW_MARKER = '<!-- factory-factory:adversarial-review -->';

/** Whether a PR review or comment body was authored by the adversarial-review feature. */
export function hasAdversarialReviewMarker(body: string | null | undefined): boolean {
  return typeof body === 'string' && body.includes(ADVERSARIAL_REVIEW_MARKER);
}
