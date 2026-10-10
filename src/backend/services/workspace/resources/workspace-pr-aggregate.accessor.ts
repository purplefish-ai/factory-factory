import { prisma } from '@/backend/db';
import type { CIStatus, PRState } from '@/shared/core';
import { type PRAggregateGuard, workspacePrAccessor } from './workspace-pr.accessor';
import { workspaceRatchetAccessor } from './workspace-ratchet.accessor';
export interface PrSnapshotPersistenceInput {
  prId?: string;
  expectedRevision?: number;
  title?: string | null;
  headRefName?: string | null;
  baseRefName?: string | null;
  prUrl?: string | null;
  prNumber: number;
  prState: PRState;
  prReviewState: string | null;
  prCiStatus: CIStatus;
  prReviewLastCheckedAt?: Date | null;
  prReviewLastCommentId?: string | null;
  prHasMergeConflict?: boolean;
  prUpdatedAt: Date;
  branchName?: string;
}

/**
 * One ratchet check's observation. Every field is an input to
 * `deriveRatchetState`, which is why this is no longer CI-only: the projection
 * reads the cache, so the check has to write what it saw.
 */
export interface PrObservationPersistenceInput {
  /**
   * The PR this observation was fetched for. Guarded, never written: the ratchet
   * does not attach PRs, it reports on the one already attached.
   *
   * The aggregate compare-and-swap cannot cover this on its own, because it reads
   * its guard inside the write transaction — it catches a write racing the
   * transaction, not a workspace re-pointed at a new PR while the check was off
   * fetching. Without this, a check that observed `MERGED` on the old PR could
   * stamp it onto the new one, and a workspace deriving `MERGED` leaves the ratchet
   * poll set altogether.
   */
  prId?: string;
  expectedRevision?: number;
  expectedPrUrl: string;
  expectedPrNumber: number;
  prCiStatus: CIStatus;
  prState: PRState;
  prReviewState: string | null;
  prHasMergeConflict: boolean;
  prUpdatedAt: Date;
  prCiFailedAt?: Date | null;
}

export interface PrAggregatePersistenceResult {
  applied: boolean;
  dispatchReset: boolean;
}

interface PrObservationIdentityGuard {
  prUrl: string;
  prNumber: number;
}

type PrAggregatePersistenceInput = Partial<{
  prUrl: string | null;
  prNumber: number | null;
  prState: PRState;
  prReviewState: string | null;
  prCiStatus: CIStatus;
  prHasMergeConflict: boolean;
  prCiFailedAt: Date | null;
  branchName: string | null;
}> & {
  prUpdatedAt: Date;
  prId?: string;
  expectedRevision?: number;
  title?: string | null;
  headRefName?: string | null;
  baseRefName?: string | null;
};

/**
 * Whether an observation moves the PR aggregate, which is what makes a settled
 * ratchet dispatch stale.
 *
 * A field the observation omits cannot have changed, so it is skipped rather
 * than compared against `undefined`. `prUpdatedAt` is deliberately not here: it
 * moves on every refresh, and counting it would reset the dispatch every time
 * the poller ran.
 */
function prAggregateChanged(
  current: PRAggregateGuard,
  observation: PrAggregatePersistenceInput
): boolean {
  const compared: Array<keyof Omit<PRAggregateGuard, 'prId' | 'revision'>> = [
    'prUrl',
    'prNumber',
    'prState',
    'prReviewState',
    'prCiStatus',
    // A conflict appearing or clearing changes the PR state a fixer was
    // dispatched for, so it invalidates a settled dispatch like any other
    // aggregate field. It joins the guard as well as the comparison, so the two
    // writers of this column cannot race each other.
    'prHasMergeConflict',
  ];
  return compared.some(
    (field) => observation[field] !== undefined && current[field] !== observation[field]
  );
}

function prIdentityChanged(
  current: PRAggregateGuard,
  expected?: PrObservationIdentityGuard
): boolean {
  if (!expected) {
    return false;
  }
  if (current.prNumber !== null && current.prNumber !== expected.prNumber) {
    return true;
  }
  return current.prUrl !== expected.prUrl;
}

class WorkspacePrAggregateAccessor {
  async apply(
    workspaceId: string,
    observation: PrAggregatePersistenceInput,
    /** The exact PR identity the observation was fetched from. */
    expectedPr?: PrObservationIdentityGuard
  ): Promise<PrAggregatePersistenceResult> {
    const { branchName, ...prFields } = observation;
    return await prisma.$transaction(async (transaction) => {
      const current = await workspacePrAccessor.readAggregate(
        transaction,
        workspaceId,
        observation.prId
      );
      if (
        !current ||
        (observation.expectedRevision !== undefined &&
          current.revision !== observation.expectedRevision)
      ) {
        return { applied: false, dispatchReset: false };
      }
      if (prIdentityChanged(current, expectedPr)) {
        return { applied: false, dispatchReset: false };
      }
      const dispatch = await workspaceRatchetAccessor.readDispatchGuard(
        transaction,
        workspaceId,
        current.prId
      );
      const shouldReset =
        prAggregateChanged(current, observation) &&
        (dispatch?.dispatchOutcome === 'COMPLETED' || dispatch?.dispatchOutcome === 'DIED');

      const applied = await workspacePrAccessor.applyAggregateIfUnchanged(
        transaction,
        workspaceId,
        current,
        prFields
      );
      if (!applied) {
        return { applied: false, dispatchReset: false };
      }

      // Attached PR metadata never changes the workspace branch.
      void branchName;

      // Only once the aggregate write has landed, and only for a dispatch that
      // has not moved on since it was read.
      const dispatchReset =
        shouldReset && dispatch
          ? await workspaceRatchetAccessor.resetSettledDispatch(
              transaction,
              workspaceId,
              dispatch,
              current.prId
            )
          : false;
      return { applied: true, dispatchReset };
    });
  }
}
export const workspacePrAggregateAccessor = new WorkspacePrAggregateAccessor();
