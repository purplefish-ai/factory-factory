import { z } from 'zod';
import {
  CIStatus,
  deriveRatchetState,
  PRState,
  RatchetState,
  type RatchetStateInput,
} from '@/shared/core';
import type { WorkspacePullRequest } from './workspace-pr';
export const WorkspacePRSummarySchema = z.object({
  totalCount: z.number(),
  openCount: z.number(),
  hasNonterminal: z.boolean(),
  state: z.nativeEnum(PRState),
  ciStatus: z.nativeEnum(CIStatus),
  hasMergeConflict: z.boolean(),
  ratchetState: z.nativeEnum(RatchetState),
});
export type WorkspacePRSummary = z.infer<typeof WorkspacePRSummarySchema>;
/** Facts shared by persisted associations and serialized workspace projections. */
export type WorkspacePRSummaryInput = Pick<
  WorkspacePullRequest,
  'state' | 'ciStatus' | 'hasMergeConflict' | 'reviewState'
>;

/** An attached NONE association is still awaiting its first GitHub observation. */
function toRatchetStateInput(
  pr: WorkspacePRSummaryInput,
  ratchetEnabled: boolean
): RatchetStateInput {
  return {
    ratchetEnabled,
    prState: pr.state === 'NONE' ? PRState.OPEN : pr.state,
    prCiStatus: pr.state === 'NONE' ? CIStatus.UNKNOWN : pr.ciStatus,
    prReviewState: pr.reviewState,
    prHasMergeConflict: pr.hasMergeConflict,
  };
}

function summarizeCI(active: readonly WorkspacePRSummaryInput[]): CIStatus {
  return active.some((pr) => pr.ciStatus === 'FAILURE')
    ? CIStatus.FAILURE
    : active.some(
          (pr) => pr.state === 'NONE' || pr.ciStatus === 'PENDING' || pr.ciStatus === 'UNKNOWN'
        )
      ? CIStatus.PENDING
      : active.length
        ? CIStatus.SUCCESS
        : CIStatus.UNKNOWN;
}
export function deriveWorkspacePRSummary<T extends WorkspacePRSummaryInput>(
  prs: readonly T[],
  ratchetEnabled: boolean
): WorkspacePRSummary {
  const active = prs.filter((pr) => pr.state !== 'MERGED' && pr.state !== 'CLOSED');
  const state = active.length
    ? PRState.OPEN
    : prs.length > 0 && prs.every((pr) => pr.state === 'MERGED')
      ? PRState.MERGED
      : prs.length
        ? PRState.CLOSED
        : PRState.NONE;
  const ciStatus = summarizeCI(active);
  const hasMergeConflict = active.some((pr) => pr.hasMergeConflict);
  const ranks = [
    RatchetState.CI_FAILED,
    RatchetState.MERGE_CONFLICT,
    RatchetState.CI_RUNNING,
    RatchetState.REVIEW_PENDING,
    RatchetState.READY,
  ];
  const states = active.map((pr) => deriveRatchetState(toRatchetStateInput(pr, ratchetEnabled)));
  const ratchetState = ratchetEnabled
    ? (ranks.find((rank) => states.includes(rank)) ??
      (state === 'MERGED' ? RatchetState.MERGED : RatchetState.IDLE))
    : RatchetState.IDLE;
  return {
    totalCount: prs.length,
    openCount: active.filter((pr) => pr.state !== 'NONE').length,
    hasNonterminal: active.length > 0,
    state,
    ciStatus:
      active.some((pr) => pr.state === 'NONE') && active.every((pr) => pr.state === 'NONE')
        ? CIStatus.UNKNOWN
        : ciStatus,
    hasMergeConflict,
    ratchetState,
  };
}
