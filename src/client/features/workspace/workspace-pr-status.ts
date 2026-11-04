import {
  getCiStateTone,
  getPrStatePresentation,
  type StatusPresentation,
} from '@/client/lib/status-tones';
import { getWorkspaceCiLabel, type WorkspaceSidebarCiState } from '@/shared/core';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';

type PrStatusFacts = Pick<WorkspacePullRequest, 'state' | 'ciStatus' | 'hasMergeConflict'>;

/** One PR's combined CI state, in the vocabulary of the sidebar and board. */
export function getPrCiState(pr: PrStatusFacts): Exclude<WorkspaceSidebarCiState, 'NONE'> {
  if (pr.state === 'MERGED' || pr.state === 'CLOSED') {
    return pr.state;
  }
  if (pr.hasMergeConflict) {
    return 'CONFLICT';
  }
  const states = {
    FAILURE: 'FAILING',
    SUCCESS: 'PASSING',
    PENDING: 'RUNNING',
    UNKNOWN: 'UNKNOWN',
  } as const;
  return states[pr.ciStatus];
}

/**
 * The single status a compact PR chip shows next to "#123": whatever most needs
 * attention, so a failing check or requested change is never hidden behind a
 * passing one. Labels and tones match the sidebar's CI chip and PR state badge.
 */
export function getPrChipStatus(pr: PrStatusFacts): StatusPresentation {
  if (pr.state === 'NONE') {
    return { tone: 'neutral', label: 'Syncing' };
  }
  const ciState = getPrCiState(pr);
  const ci: StatusPresentation = {
    tone: getCiStateTone(ciState),
    label: getWorkspaceCiLabel(ciState),
  };
  const review = getPrStatePresentation(pr.state);
  // Terminal states, conflicts and failing checks outrank any review outcome.
  if (ciState !== 'PASSING' && ciState !== 'RUNNING' && ciState !== 'UNKNOWN') {
    return ci;
  }
  if (pr.state === 'CHANGES_REQUESTED' && review) {
    return review;
  }
  if (ciState === 'RUNNING') {
    return ci;
  }
  if ((pr.state === 'APPROVED' || pr.state === 'DRAFT') && review) {
    return review;
  }
  if (ciState === 'PASSING') {
    return ci;
  }
  return review ?? ci;
}
