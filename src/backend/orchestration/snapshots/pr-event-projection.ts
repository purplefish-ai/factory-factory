import type { WorkspacePullRequest } from '@/shared/workspace-pr';

export function shouldRefreshRatchetForPrSwitch(
  previousSnapshot:
    | {
        prs?: WorkspacePullRequest[];
        prNumber?: number | null;
        prUrl?: string | null;
        prState?: string;
      }
    | undefined,
  event: { prNumber?: number | null; prUrl?: string | null; prState?: string }
): boolean {
  if (!previousSnapshot) {
    return false;
  }

  const linkedPr = previousSnapshot.prs?.find((pr) => event.prUrl && pr.url === event.prUrl);
  if (linkedPr?.state === 'CLOSED' && event.prState !== 'CLOSED' && event.prState !== 'MERGED') {
    return true;
  }
  if (linkedPr) {
    return false;
  }

  const hadPreviouslyLinkedPr = previousSnapshot.prNumber != null || previousSnapshot.prUrl != null;
  if (!hadPreviouslyLinkedPr) {
    return false;
  }

  const prNumberChanged =
    previousSnapshot.prNumber != null && previousSnapshot.prNumber !== event.prNumber;
  const prUrlChanged =
    previousSnapshot.prUrl != null &&
    event.prUrl !== undefined &&
    event.prUrl !== null &&
    previousSnapshot.prUrl !== event.prUrl;
  // The ratchet poll query excludes prState CLOSED, so a reopened PR needs an
  // immediate check here to resume ratcheting as soon as the reopen is synced.
  // A reopened PR can land on any non-CLOSED state (OPEN/DRAFT/APPROVED/...).
  const prReopened =
    previousSnapshot.prState === 'CLOSED' && event.prState != null && event.prState !== 'CLOSED';

  return prNumberChanged || prUrlChanged || prReopened;
}
