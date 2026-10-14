import { prisma } from '@/backend/db';
import type { CIStatus, PRState } from '@/shared/core';
import { type PRAggregateGuard, workspacePrAccessor } from './workspace-pr.accessor';
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

      return { applied: true, dispatchReset: false };
    });
  }
}
export const workspacePrAggregateAccessor = new WorkspacePrAggregateAccessor();
