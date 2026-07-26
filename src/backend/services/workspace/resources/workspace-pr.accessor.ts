import type { Prisma, WorkspacePR } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import type { PRDiscoveryClaim, PRSnapshotFields } from '@/backend/services/workspace/types';
import type { CIStatus, PRState } from '@/shared/core';

/**
 * Persistence for `WorkspacePR`, the cached view of a workspace's pull request.
 *
 * This file is the only writer of that table. Before the split these thirteen
 * columns sat on `Workspace`, and `scripts/check-single-writer.mjs` was what
 * stopped four different services writing them; now the type system is, because
 * no other accessor can name the columns.
 *
 * Callers still speak in the flat `pr*` names the columns had. Those names are
 * threaded through service bridges, the snapshot wire and the v4 export format,
 * so they stay; the mapping to the unprefixed column names happens here and
 * nowhere else.
 *
 * Two writes span this table and `Workspace` — correcting a branch name
 * alongside a PR refresh, and clearing the discovery schedule when a branch is
 * renamed. Those take a transaction from the caller so the pair still lands
 * atomically, the same arrangement `workspaceRatchetAccessor` uses for the
 * dispatch reset.
 */

/**
 * The PR cache as callers above the accessor see it: flattened onto the
 * workspace shape they already consumed, so the table split stops here.
 *
 * `prUpdatedAt` is the one name that lies. It never held GitHub's PR
 * `updated_at` — every caller passes its own observation time — so the column is
 * `syncedAt`. The caller-facing name is unchanged because it reaches the
 * snapshot wire and the export format, which cannot be renamed independently.
 */
export interface WorkspacePRFields {
  prUrl: string | null;
  prNumber: number | null;
  prState: PRState;
  prReviewState: string | null;
  prCiStatus: CIStatus;
  /**
   * GitHub's `mergeStateStatus == DIRTY`. Cached because `deriveRatchetState`
   * needs it and nothing else persisted it: the ratchet used to fold a conflict
   * straight into `RatchetState.MERGE_CONFLICT` and store only that.
   */
  prHasMergeConflict: boolean;
  prUpdatedAt: Date | null;
  prDiscoveryLastCheckedAt: Date | null;
  prDiscoveryRetryCount: number;
  prDiscoveryNextCheckAt: Date | null;
  prCiFailedAt: Date | null;
  prCiLastNotifiedAt: Date | null;
  prReviewLastCheckedAt: Date | null;
  prReviewLastCommentId: string | null;
}

/**
 * What a workspace with no PR row reads as. Matches the column defaults, so it
 * is the same answer the old `Workspace` columns gave a freshly created row.
 *
 * A row is created with every workspace (see `workspaceAccessor.create`) and the
 * split migration backfilled every existing one, so this covers data that
 * arrived by another route — a pre-split backup restored, say — rather than an
 * expected state.
 */
export const WORKSPACE_PR_DEFAULTS: WorkspacePRFields = {
  prUrl: null,
  prNumber: null,
  prState: 'NONE',
  prReviewState: null,
  prCiStatus: 'UNKNOWN',
  prHasMergeConflict: false,
  prUpdatedAt: null,
  prDiscoveryLastCheckedAt: null,
  prDiscoveryRetryCount: 0,
  prDiscoveryNextCheckAt: null,
  prCiFailedAt: null,
  prCiLastNotifiedAt: null,
  prReviewLastCheckedAt: null,
  prReviewLastCommentId: null,
};

/** The persisted row, as joined onto a workspace read. */
export type WorkspacePRRow = WorkspacePR;

/** Flatten a joined PR row onto the caller-facing field names. */
export function flattenWorkspacePR(pr: WorkspacePR | null | undefined): WorkspacePRFields {
  if (!pr) {
    return { ...WORKSPACE_PR_DEFAULTS };
  }
  return {
    prUrl: pr.url,
    prNumber: pr.number,
    prState: pr.state,
    prReviewState: pr.reviewState,
    prCiStatus: pr.ciStatus,
    prHasMergeConflict: pr.hasMergeConflict,
    prUpdatedAt: pr.syncedAt,
    prDiscoveryLastCheckedAt: pr.discoveryLastCheckedAt,
    prDiscoveryRetryCount: pr.discoveryRetryCount,
    prDiscoveryNextCheckAt: pr.discoveryNextCheckAt,
    prCiFailedAt: pr.ciFailedAt,
    prCiLastNotifiedAt: pr.ciLastNotifiedAt,
    prReviewLastCheckedAt: pr.reviewLastCheckedAt,
    prReviewLastCommentId: pr.reviewLastCommentId,
  };
}

/** The subset of the PR cache a caller may write in one unconditional update. */
export type WorkspacePRWriteFields = Partial<WorkspacePRFields>;

/**
 * Translate caller-facing `pr*` names to column names, dropping keys the caller
 * left absent so a partial write stays partial. `undefined` means "not
 * supplied"; `null` is a value and is written.
 */
function toColumns(fields: WorkspacePRWriteFields): Prisma.WorkspacePRUpdateInput {
  const columns: Prisma.WorkspacePRUpdateInput = {};
  if (fields.prUrl !== undefined) {
    columns.url = fields.prUrl;
  }
  if (fields.prNumber !== undefined) {
    columns.number = fields.prNumber;
  }
  if (fields.prState !== undefined) {
    columns.state = fields.prState;
  }
  if (fields.prReviewState !== undefined) {
    columns.reviewState = fields.prReviewState;
  }
  if (fields.prCiStatus !== undefined) {
    columns.ciStatus = fields.prCiStatus;
  }
  if (fields.prHasMergeConflict !== undefined) {
    columns.hasMergeConflict = fields.prHasMergeConflict;
  }
  if (fields.prUpdatedAt !== undefined) {
    columns.syncedAt = fields.prUpdatedAt;
  }
  if (fields.prDiscoveryLastCheckedAt !== undefined) {
    columns.discoveryLastCheckedAt = fields.prDiscoveryLastCheckedAt;
  }
  if (fields.prDiscoveryRetryCount !== undefined) {
    columns.discoveryRetryCount = fields.prDiscoveryRetryCount;
  }
  if (fields.prDiscoveryNextCheckAt !== undefined) {
    columns.discoveryNextCheckAt = fields.prDiscoveryNextCheckAt;
  }
  if (fields.prCiFailedAt !== undefined) {
    columns.ciFailedAt = fields.prCiFailedAt;
  }
  if (fields.prCiLastNotifiedAt !== undefined) {
    columns.ciLastNotifiedAt = fields.prCiLastNotifiedAt;
  }
  if (fields.prReviewLastCheckedAt !== undefined) {
    columns.reviewLastCheckedAt = fields.prReviewLastCheckedAt;
  }
  if (fields.prReviewLastCommentId !== undefined) {
    columns.reviewLastCommentId = fields.prReviewLastCommentId;
  }
  return columns;
}

/** The aggregate fields a refresh compares against before writing. */
export interface PRAggregateGuard {
  prUrl: string | null;
  prNumber: number | null;
  prState: PRState;
  prReviewState: string | null;
  prCiStatus: CIStatus;
  prHasMergeConflict: boolean;
  prUpdatedAt: Date | null;
}

/** A workspace-and-project row carrying the flattened PR cache. */
export type WorkspacePRCandidate = Omit<
  Prisma.WorkspaceGetPayload<{ include: { project: true; pr: true } }>,
  'pr'
> &
  WorkspacePRFields;

function withPR(
  row: Prisma.WorkspaceGetPayload<{ include: { project: true; pr: true } }>
): WorkspacePRCandidate {
  const { pr, ...workspace } = row;
  return { ...workspace, ...flattenWorkspacePR(pr) };
}

class WorkspacePRAccessor {
  /**
   * READY workspaces with a PR whose cache is stale, oldest sync first.
   *
   * The `status` filter is on `Workspace` and the rest on `WorkspacePR`, so this
   * is a join where it used to be a single covering index. At this table's size
   * that is not a cost worth an index to avoid.
   */
  async findNeedingSync(staleThresholdMinutes = 5): Promise<WorkspacePRCandidate[]> {
    const staleThreshold = new Date(Date.now() - staleThresholdMinutes * 60 * 1000);

    const rows = await prisma.workspace.findMany({
      where: {
        status: 'READY',
        pr: {
          url: { not: null },
          OR: [{ syncedAt: null }, { syncedAt: { lt: staleThreshold } }],
        },
      },
      include: { project: true, pr: true },
      orderBy: { pr: { syncedAt: 'asc' } }, // Oldest first
    });
    return rows.map(withPR);
  }

  /**
   * READY workspaces with a branch, no PR yet, and a discovery check due.
   */
  async findNeedingDiscovery(limit: number, dueAt = new Date()): Promise<WorkspacePRCandidate[]> {
    const rows = await prisma.workspace.findMany({
      where: {
        status: 'READY',
        branchName: { not: null },
        project: {
          githubOwner: { not: null },
          githubRepo: { not: null },
        },
        pr: {
          url: null,
          OR: [{ discoveryNextCheckAt: null }, { discoveryNextCheckAt: { lte: dueAt } }],
        },
      },
      include: { project: true, pr: true },
      orderBy: [{ pr: { discoveryNextCheckAt: 'asc' } }, { updatedAt: 'desc' }],
      take: limit,
    });
    return rows.map(withPR);
  }

  /**
   * Claim a due PR discovery candidate using the values observed by the caller.
   * Concurrent activity or eligibility changes win by making this update a no-op.
   *
   * The status, branch and activity guards are relation filters because those
   * columns stayed on `Workspace`; the retry and schedule guards are this row's.
   * One consequence of the split: claiming no longer bumps `Workspace.updatedAt`,
   * so a discovery poll no longer registers as workspace activity — it never
   * should have, and the CAS is unaffected because the retry count still moves.
   */
  async claimDiscoveryAttempt(
    workspaceId: string,
    attempt: {
      branchName: string;
      expectedUpdatedAt: Date;
      expectedRetryCount: number;
      expectedNextCheckAt: Date | null;
      checkedAt: Date;
      nextCheckAt: Date;
    }
  ): Promise<boolean> {
    const result = await prisma.workspacePR.updateMany({
      where: {
        workspaceId,
        url: null,
        discoveryRetryCount: attempt.expectedRetryCount,
        discoveryNextCheckAt: attempt.expectedNextCheckAt,
        workspace: {
          status: 'READY',
          branchName: attempt.branchName,
          updatedAt: attempt.expectedUpdatedAt,
        },
      },
      data: {
        discoveryLastCheckedAt: attempt.checkedAt,
        discoveryRetryCount: { increment: 1 },
        discoveryNextCheckAt: attempt.nextCheckAt,
      },
    });
    return result.count > 0;
  }

  /**
   * Atomically attach a discovered PR only while the claim that produced it is
   * still current. A concurrent reset, branch rename, status change, or PR
   * attachment makes this update a no-op.
   */
  async attachDiscoveredPRIfClaimMatches(
    workspaceId: string,
    prUrl: string,
    claim: PRDiscoveryClaim,
    prUpdatedAt: Date
  ): Promise<boolean> {
    const result = await prisma.workspacePR.updateMany({
      where: {
        workspaceId,
        url: null,
        discoveryLastCheckedAt: claim.checkedAt,
        discoveryRetryCount: claim.retryCount,
        discoveryNextCheckAt: claim.nextCheckAt,
        workspace: { status: 'READY', branchName: claim.branchName },
      },
      data: { url: prUrl, syncedAt: prUpdatedAt },
    });
    return result.count > 0;
  }

  /** Atomically update snapshot fields only while the expected PR remains attached. */
  async updateSnapshotIfUrlMatches(
    workspaceId: string,
    prUrl: string,
    snapshot: PRSnapshotFields,
    prUpdatedAt: Date
  ): Promise<boolean> {
    const result = await prisma.workspacePR.updateMany({
      where: { workspaceId, url: prUrl },
      data: {
        number: snapshot.prNumber,
        state: snapshot.prState,
        reviewState: snapshot.prReviewState,
        ciStatus: snapshot.prCiStatus,
        syncedAt: prUpdatedAt,
      },
    });
    return result.count > 0;
  }

  /** Make an eligible workspace immediately due for PR discovery again. */
  async resetDiscoveryBackoff(workspaceId: string): Promise<boolean> {
    const result = await prisma.workspacePR.updateMany({
      where: {
        workspaceId,
        url: null,
        workspace: { status: 'READY', branchName: { not: null } },
      },
      data: {
        discoveryLastCheckedAt: null,
        discoveryRetryCount: 0,
        discoveryNextCheckAt: null,
      },
    });
    return result.count > 0;
  }

  /**
   * Clear the discovery schedule so the next poll re-checks immediately. Runs in
   * the caller's transaction because its only caller changes the branch name in
   * the same breath, and a branch rename with a stale backoff would keep
   * discovery pointed at the old branch until the backoff expired.
   */
  async clearDiscoverySchedule(
    transaction: Prisma.TransactionClient,
    workspaceId: string
  ): Promise<void> {
    const result = await transaction.workspacePR.updateMany({
      where: { workspaceId },
      data: {
        discoveryLastCheckedAt: null,
        discoveryRetryCount: 0,
        discoveryNextCheckAt: null,
      },
    });
    // Same reasoning as `writeInTransaction`: this is half of a pair, and the
    // other half is the branch rename that makes the old backoff wrong.
    if (result.count === 0) {
      throw new Error(`WorkspacePR row not found for workspace: ${workspaceId}`);
    }
  }

  /**
   * Unconditionally write the supplied subset of the PR cache.
   *
   * Throws if no row matched. A row exists for every workspace, so the only way
   * to miss is a workspace deleted between an observation being fetched and
   * persisted — which is what the pre-split write did too, by way of
   * `prisma.workspace.update` raising on a missing row. Preserved deliberately:
   * `updateMany` would otherwise report success for a discarded observation, and
   * the PR sync scheduler counts those failures.
   */
  async write(workspaceId: string, fields: WorkspacePRWriteFields): Promise<void> {
    const data = toColumns(fields);
    if (Object.keys(data).length === 0) {
      return;
    }
    const result = await prisma.workspacePR.updateMany({ where: { workspaceId }, data });
    if (result.count === 0) {
      throw new Error(`WorkspacePR row not found for workspace: ${workspaceId}`);
    }
  }

  /**
   * As `write`, in the caller's transaction — including the missing-row throw,
   * which matters more here than it does there. Its caller pairs this with a
   * `branchName` update, so swallowing a zero-row PR update would commit the
   * rename with no PR cache write beside it. The throw rolls the transaction back
   * instead.
   */
  async writeInTransaction(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
    fields: WorkspacePRWriteFields
  ): Promise<void> {
    const data = toColumns(fields);
    if (Object.keys(data).length === 0) {
      return;
    }
    const result = await transaction.workspacePR.updateMany({ where: { workspaceId }, data });
    if (result.count === 0) {
      throw new Error(`WorkspacePR row not found for workspace: ${workspaceId}`);
    }
  }

  /**
   * Read the aggregate a refresh compares against, inside the caller's
   * transaction so the value it returns is the one `applyAggregateIfUnchanged`
   * guards on.
   */
  async readAggregate(
    transaction: Prisma.TransactionClient,
    workspaceId: string
  ): Promise<PRAggregateGuard | null> {
    const row = await transaction.workspacePR.findUnique({
      where: { workspaceId },
      select: {
        url: true,
        number: true,
        state: true,
        reviewState: true,
        ciStatus: true,
        hasMergeConflict: true,
        syncedAt: true,
      },
    });
    if (!row) {
      return null;
    }
    return {
      prUrl: row.url,
      prNumber: row.number,
      prState: row.state,
      prReviewState: row.reviewState,
      prCiStatus: row.ciStatus,
      prHasMergeConflict: row.hasMergeConflict,
      prUpdatedAt: row.syncedAt,
    };
  }

  /**
   * Write a refreshed aggregate, compare-and-swap on the aggregate the caller
   * read. A concurrent refresh that already moved the cache wins and this is a
   * no-op, which is what tells the caller not to reset a settled dispatch.
   */
  async applyAggregateIfUnchanged(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
    guard: PRAggregateGuard,
    fields: WorkspacePRWriteFields
  ): Promise<boolean> {
    const result = await transaction.workspacePR.updateMany({
      where: {
        workspaceId,
        url: guard.prUrl,
        number: guard.prNumber,
        state: guard.prState,
        reviewState: guard.prReviewState,
        hasMergeConflict: guard.prHasMergeConflict,
        ciStatus: guard.prCiStatus,
        syncedAt: guard.prUpdatedAt,
      },
      data: toColumns(fields),
    });
    return result.count > 0;
  }
}

export const workspacePrAccessor = new WorkspacePRAccessor();
