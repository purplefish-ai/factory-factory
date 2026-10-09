import type { PRSnapshotUpdatedEvent, PRUrlAttachedEvent } from '@/backend/services/github';
import type { SnapshotUpdateInput } from '@/backend/services/workspace';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import { deriveWorkspacePRSummary } from '@/shared/workspace-pr-summary';
import type { WorkspaceSnapshotEntry } from '@/shared/workspace-snapshot';

function projectLegacyEvent(
  previous: WorkspaceSnapshotEntry | undefined,
  event: PRUrlAttachedEvent | PRSnapshotUpdatedEvent
): SnapshotUpdateInput {
  // Compatibility with older event emitters during a rolling update.
  return 'prState' in event
    ? {
        prState: event.prState as WorkspacePullRequest['state'],
        prNumber: event.prNumber,
        prCiStatus: event.prCiStatus as WorkspacePullRequest['ciStatus'],
        ...(event.prUrl ? { prUrl: event.prUrl } : {}),
        ...((previous?.prState === 'MERGED' || previous?.prState === 'CLOSED') &&
        event.prState !== 'MERGED' &&
        event.prState !== 'CLOSED'
          ? { ratchetState: 'IDLE' as const }
          : {}),
      }
    : {
        prUrl: event.prUrl,
        prNumber: null,
        prState: 'NONE',
        prCiStatus: 'UNKNOWN',
        ratchetState: 'IDLE',
        hasMergeConflict: false,
      };
}

function resolveEventPrId(
  previous: WorkspaceSnapshotEntry | undefined,
  event: PRUrlAttachedEvent | PRSnapshotUpdatedEvent
): string | undefined {
  if (event.prId) {
    return event.prId;
  }
  const matches =
    previous?.prs?.filter((pr) =>
      event.prUrl ? pr.url === event.prUrl : 'prState' in event && pr.number === event.prNumber
    ) ?? [];
  return matches.length === 1 ? matches[0]?.id : undefined;
}

/** Publish a coherent collection immediately, before the authoritative read. */
export function projectPrEvent(
  previous: WorkspaceSnapshotEntry | undefined,
  event: PRUrlAttachedEvent | PRSnapshotUpdatedEvent
): SnapshotUpdateInput {
  const updated = 'prState' in event;
  const prId = resolveEventPrId(previous, event);
  const url = event.prUrl ?? previous?.prs?.find((pr) => pr.id === prId)?.url ?? previous?.prUrl;
  if (!(prId && url)) {
    if (previous?.prs?.length) {
      return {};
    }
    return projectLegacyEvent(previous, event);
  }
  const prs = [...(previous?.prs ?? [])];
  const index = prs.findIndex((pr) => pr.id === prId);
  const existing = index >= 0 ? prs[index] : undefined;
  const pr: WorkspacePullRequest = {
    id: prId,
    url,
    number: null,
    title: null,
    headRefName: null,
    baseRefName: null,
    state: 'NONE',
    reviewState: null,
    ciStatus: 'UNKNOWN',
    hasMergeConflict: false,
    syncedAt: null,
    ...existing,
    ...(updated
      ? {
          number: event.prNumber,
          state: event.prState as WorkspacePullRequest['state'],
          ciStatus: event.prCiStatus as WorkspacePullRequest['ciStatus'],
          reviewState: event.prReviewState,
        }
      : {}),
  };
  if (index >= 0) {
    prs[index] = pr;
  } else {
    prs.push(pr);
  }
  const summary = deriveWorkspacePRSummary(prs, previous?.ratchetEnabled ?? true);
  return {
    prs,
    prSummary: summary,
    prUrl: prs.length === 1 ? pr.url : null,
    prNumber: prs.length === 1 ? pr.number : null,
    prState: summary.state,
    prCiStatus: summary.ciStatus,
    hasMergeConflict: summary.hasMergeConflict,
    ratchetState: summary.ratchetState,
  };
}

export function shouldRefreshRatchetForPrSwitch(
  previousSnapshot:
    | {
        prs?: WorkspacePullRequest[];
        prNumber?: number | null;
        prUrl?: string | null;
        prState?: string;
      }
    | undefined,
  event: { prId?: string; prNumber?: number | null; prUrl?: string | null; prState?: string }
): boolean {
  if (!previousSnapshot) {
    return false;
  }

  const linkedPr = previousSnapshot.prs?.find((pr) =>
    event.prId ? pr.id === event.prId : event.prUrl && pr.url === event.prUrl
  );
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
