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
    ratchet: {
      lastCheckedAt: null,
      dispatchOutcome: null,
      dispatchRetryCount: 0,
      dispatchStalled: false,
    },
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
    ratchetDispatchStalled: summary.dispatchStalled,
  };
}
