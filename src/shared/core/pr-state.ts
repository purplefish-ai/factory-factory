import { PRState } from './enums.js';

/**
 * Cached `PRState` values that mean the GitHub PR is open.
 *
 * GitHub's raw `state` is just `OPEN`/`CLOSED`/`MERGED`, where a draft or
 * reviewed PR is `OPEN`. `computePRState` folds draft status and review
 * decision into the same enum, so recovering "is this PR open" means naming the
 * four values that mean yes rather than comparing against `PRState.OPEN`.
 */
const OPEN_PR_STATES: ReadonlySet<string> = new Set<PRState>([
  PRState.OPEN,
  PRState.DRAFT,
  PRState.CHANGES_REQUESTED,
  PRState.APPROVED,
]);

export function isOpenPrState(state: string | null | undefined): boolean {
  return state !== null && state !== undefined && OPEN_PR_STATES.has(state);
}
