import { createHash } from 'node:crypto';
import type { Prisma, WorkspacePR } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import type {
  PRDiscoveryClaim,
  PRSnapshotFields,
  WorkspacePRIdentity,
} from '@/backend/services/workspace/types';
import type { CIStatus, PRState } from '@/shared/core';
import { type PRObservation, type PRTarget, reducePRObservation } from '@/shared/pr-monitoring';
import {
  prMonitoringEventPayloadSchema,
  prObservationSchema,
} from '@/shared/schemas/pr-event.schema';
import { workspacePrDiscoveryAccessor } from './workspace-pr-discovery.accessor';
import { workspacePrEventAccessor } from './workspace-pr-event.accessor';

export interface WorkspacePRFields {
  title?: string | null;
  headRefName?: string | null;
  baseRefName?: string | null;
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
    prDiscoveryLastCheckedAt: null,
    prDiscoveryRetryCount: 0,
    prDiscoveryNextCheckAt: null,
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
function assignPRMetadata(columns: Prisma.WorkspacePRUpdateInput, fields: WorkspacePRWriteFields) {
  if (fields.title !== undefined) {
    columns.title = fields.title;
  }
  if (fields.headRefName !== undefined) {
    columns.headRefName = fields.headRefName;
  }
  if (fields.baseRefName !== undefined) {
    columns.baseRefName = fields.baseRefName;
  }
}
function toColumns(fields: WorkspacePRWriteFields): Prisma.WorkspacePRUpdateInput {
  const columns: Prisma.WorkspacePRUpdateInput = {};
  assignPRMetadata(columns, fields);
  if (fields.prUrl !== undefined) {
    if (fields.prUrl !== null) {
      columns.url = fields.prUrl;
    }
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

export type WorkspacePRRecord = WorkspacePR;
export interface PRAggregateGuard {
  prId: string;
  revision: number;
  prUrl: string | null;
  prNumber: number | null;
  prState: PRState;
  prReviewState: string | null;
  prCiStatus: CIStatus;
  prHasMergeConflict: boolean;
  prUpdatedAt: Date | null;
}

class WorkspacePRAccessor {
  acceptMonitoredObservation(input: {
    target: PRTarget;
    expectedPrRevision: number;
    observation: PRObservation;
    expectedEventEpoch: number;
  }) {
    const observation = prObservationSchema.parse(input.observation);
    return prisma.$transaction(async (tx) => {
      const row = await tx.workspacePR.findFirst({
        where: {
          id: input.target.prId,
          workspaceId: input.target.workspaceId,
          detachedAt: null,
          revision: input.expectedPrRevision,
        },
      });
      const config = await tx.workspacePRMonitoring.findUnique({
        where: { workspaceId: input.target.workspaceId },
      });
      if (
        !row ||
        row.url !== observation.url ||
        !config ||
        config.eventEpoch !== input.expectedEventEpoch
      ) {
        return { applied: false, eventIds: [] };
      }
      const baseline = row.observation === null ? null : prObservationSchema.parse(row.observation);
      const previous = row.observationEpoch === config.eventEpoch ? baseline : null;
      const rows = await workspacePrEventAccessor.listForPR(tx, row.id);
      const events = rows
        .filter((e) => e.deduplicationKey.startsWith(`${row.id}:epoch:${config.eventEpoch}:`))
        .map((e) => {
          const payload = prMonitoringEventPayloadSchema.parse(e.payload);
          return { ...e, kind: payload.kind, payload };
        });
      const reduction = reducePRObservation({
        hashIdentity: (identity) => createHash('sha256').update(identity).digest('hex'),
        target: input.target,
        previous,
        current: observation,
        transitionSequence: row.transitionSequence,
        eventEpoch: config.eventEpoch,
        pendingEvents: events.filter((e) => e.state === 'PENDING' && !e.deliveryId),
        deliveredEvents: events.filter((e) => e.state === 'DELIVERED'),
      });
      const updated = await tx.workspacePR.updateMany({
        where: { id: row.id, revision: input.expectedPrRevision, detachedAt: null },
        data: {
          number: observation.number,
          headRefName: observation.headBranch,
          baseRefName: observation.baseBranch,
          state: observation.prState,
          ciStatus: observation.ciStatus,
          reviewState: observation.reviewState,
          hasMergeConflict: observation.hasMergeConflict,
          syncedAt: new Date(observation.observedAt),
          revision: { increment: 1 },
          observation:
            !observation.reviewsComplete && baseline
              ? {
                  ...observation,
                  actionableReviews: [
                    ...observation.actionableReviews,
                    ...baseline.actionableReviews.filter(
                      (r) => !observation.actionableReviews.some((c) => c.identity === r.identity)
                    ),
                  ],
                }
              : observation,
          transitionSequence: reduction.nextTransitionSequence,
          observationEpoch: config.eventEpoch,
        },
      });
      if (!updated.count) {
        return { applied: false, eventIds: [] };
      }
      if (!config.enabled) {
        return { applied: true, eventIds: [] };
      }
      await workspacePrEventAccessor.supersede(tx, reduction.supersededEventIds);
      return {
        applied: true,
        eventIds: await workspacePrEventAccessor.insert(
          tx,
          row.workspaceId,
          row.id,
          reduction.events
        ),
      };
    });
  }
  list(workspaceId: string): Promise<WorkspacePRRecord[]> {
    return prisma.workspacePR.findMany({
      where: { workspaceId, detachedAt: null },
      orderBy: { id: 'asc' },
    });
  }
  findByIdentity(target: WorkspacePRIdentity): Promise<WorkspacePRRecord | null> {
    return prisma.workspacePR.findFirst({
      where: { id: target.prId, workspaceId: target.workspaceId, detachedAt: null },
    });
  }
  attach(workspaceId: string, url: string) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.workspacePR.findUnique({
        where: { workspaceId_url: { workspaceId, url } },
      });
      if (existing) {
        if (existing.detachedAt) {
          await tx.workspacePR.update({
            where: { id: existing.id },
            data: { detachedAt: null, revision: { increment: 1 } },
          });
        }
        return { prId: existing.id, created: false, reattached: existing.detachedAt !== null };
      }
      const pr = await tx.workspacePR.create({ data: { workspaceId, url } });

      return { prId: pr.id, created: true, reattached: false };
    });
  }
  async detach(target: WorkspacePRIdentity) {
    const result = await prisma.workspacePR.updateMany({
      where: { id: target.prId, workspaceId: target.workspaceId, detachedAt: null },
      data: { detachedAt: new Date(), revision: { increment: 1 } },
    });
    return result.count > 0;
  }
  attachDiscoveredPRsIfClaimMatches(workspaceId: string, claim: PRDiscoveryClaim, urls: string[]) {
    return prisma.$transaction(async (tx) => {
      if (!(await workspacePrDiscoveryAccessor.claimMatches(tx, workspaceId, claim))) {
        return [];
      }
      const ids: string[] = [];
      for (const url of urls) {
        if (await tx.workspacePR.findUnique({ where: { workspaceId_url: { workspaceId, url } } })) {
          continue;
        }
        const pr = await tx.workspacePR.create({
          data: { workspaceId, url, headRefName: claim.branchName },
        });

        ids.push(pr.id);
      }
      return ids;
    });
  }
  async findNeedingSync(staleThresholdMinutes = 5) {
    const rows = await prisma.workspacePR.findMany({
      where: {
        detachedAt: null,
        workspace: { status: 'READY' },
        OR: [
          { syncedAt: null },
          { syncedAt: { lt: new Date(Date.now() - staleThresholdMinutes * 60_000) } },
        ],
      },
      include: { workspace: { include: { project: true } } },
      orderBy: { syncedAt: 'asc' },
    });
    return rows.map(({ workspace, ...pr }) => ({
      ...workspace,
      prId: pr.id,
      ...flattenWorkspacePR(pr),
    }));
  }
  findNeedingDiscovery(limit: number, dueAt = new Date()) {
    return workspacePrDiscoveryAccessor.findNeedingDiscovery(limit, dueAt);
  }
  claimDiscoveryAttempt(
    ...args: Parameters<typeof workspacePrDiscoveryAccessor.claimDiscoveryAttempt>
  ) {
    return workspacePrDiscoveryAccessor.claimDiscoveryAttempt(...args);
  }
  resetDiscoveryBackoff(workspaceId: string) {
    return workspacePrDiscoveryAccessor.resetDiscoveryBackoff(workspaceId);
  }
  clearDiscoverySchedule(tx: Prisma.TransactionClient, workspaceId: string) {
    return workspacePrDiscoveryAccessor.clearDiscoverySchedule(tx, workspaceId);
  }
  async attachDiscoveredPRIfClaimMatches(
    workspaceId: string,
    url: string,
    claim: PRDiscoveryClaim,
    _at: Date
  ) {
    return (await this.attachDiscoveredPRsIfClaimMatches(workspaceId, claim, [url])).length > 0;
  }
  async readAggregate(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    prId?: string
  ): Promise<PRAggregateGuard | null> {
    const rows = await tx.workspacePR.findMany({
      where: { workspaceId, detachedAt: null, ...(prId ? { id: prId } : {}) },
      take: 2,
    });
    if (rows.length !== 1 || !rows[0]) {
      return null;
    }
    const row = rows[0];
    return { prId: row.id, revision: row.revision, ...flattenWorkspacePR(row) };
  }
  async write(workspaceId: string, fields: WorkspacePRWriteFields, prId?: string): Promise<void> {
    await prisma.$transaction((tx) => this.writeInTransaction(tx, workspaceId, fields, prId));
  }
  async writeInTransaction(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    fields: WorkspacePRWriteFields,
    prId?: string
  ) {
    const row = await this.readAggregate(tx, workspaceId, prId);
    if (!row) {
      throw new Error(`Explicit PR identity required for workspace: ${workspaceId}`);
    }
    await this.applyAggregateIfUnchanged(tx, workspaceId, row, fields);
  }
  async applyAggregateIfUnchanged(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    guard: PRAggregateGuard,
    fields: WorkspacePRWriteFields
  ) {
    const result = await tx.workspacePR.updateMany({
      where: { id: guard.prId, workspaceId, detachedAt: null, revision: guard.revision },
      data: { ...toColumns(fields), revision: { increment: 1 } },
    });
    return result.count > 0;
  }
  async updateSnapshotIfUrlMatches(
    workspaceId: string,
    url: string,
    snapshot: PRSnapshotFields,
    at: Date
  ) {
    const result = await prisma.workspacePR.updateMany({
      where: { workspaceId, url, detachedAt: null },
      data: { ...toColumns({ ...snapshot, prUpdatedAt: at }), revision: { increment: 1 } },
    });
    return result.count > 0;
  }
  async findPRState(workspaceId: string, prId?: string) {
    const rows = await prisma.workspacePR.findMany({
      where: { workspaceId, detachedAt: null, ...(prId ? { id: prId } : {}) },
      take: 2,
    });
    const row = rows.length === 1 ? rows[0] : undefined;
    return row ? { prId: row.id, prUrl: row.url, prNumber: row.number, prState: row.state } : null;
  }
}
export const workspacePrAccessor = new WorkspacePRAccessor();
