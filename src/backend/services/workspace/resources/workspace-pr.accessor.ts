import type { Prisma, WorkspacePR, WorkspacePRRatchet } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import type { PRDiscoveryClaim, WorkspacePRIdentity } from '@/backend/services/workspace/types';
import type { CIStatus, PRState } from '@/shared/core';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import { workspacePrDiscoveryAccessor } from './workspace-pr-discovery.accessor';
import { workspacePrRatchetAccessor } from './workspace-pr-ratchet.accessor';

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
export type WorkspacePRRow = WorkspacePR & { automation?: WorkspacePRRatchet | null };

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
function toColumns(fields: WorkspacePRWriteFields): Prisma.WorkspacePRUpdateInput {
  const columns: Prisma.WorkspacePRUpdateInput = {};
  if (fields.title !== undefined) {
    columns.title = fields.title;
  }
  if (fields.headRefName !== undefined) {
    columns.headRefName = fields.headRefName;
  }
  if (fields.baseRefName !== undefined) {
    columns.baseRefName = fields.baseRefName;
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

export type WorkspacePRRecord = Prisma.WorkspacePRGetPayload<{ include: { automation: true } }>;
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

export function serializeWorkspacePR(pr: WorkspacePRRow): WorkspacePullRequest {
  return {
    id: pr.id,
    url: pr.url,
    number: pr.number,
    title: pr.title,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    state: pr.state,
    reviewState: pr.reviewState,
    ciStatus: pr.ciStatus,
    hasMergeConflict: pr.hasMergeConflict,
    syncedAt: pr.syncedAt?.toISOString() ?? null,
    ratchet: {
      lastCheckedAt: pr.automation?.lastCheckedAt?.toISOString() ?? null,
      dispatchOutcome: pr.automation?.dispatchOutcome ?? null,
      dispatchRetryCount: pr.automation?.dispatchRetryCount ?? 0,
      dispatchStalled: pr.automation?.dispatchStalled ?? false,
    },
  };
}

class WorkspacePRAccessor {
  list(workspaceId: string): Promise<WorkspacePRRecord[]> {
    return prisma.workspacePR.findMany({
      where: { workspaceId, detachedAt: null },
      include: { automation: true },
      orderBy: { id: 'asc' },
    });
  }
  findByIdentity(target: WorkspacePRIdentity): Promise<WorkspacePRRecord | null> {
    return prisma.workspacePR.findFirst({
      where: { id: target.prId, workspaceId: target.workspaceId, detachedAt: null },
      include: { automation: true },
    });
  }
  async attach(workspaceId: string, url: string) {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.workspacePR.findUnique({
        where: { workspaceId_url: { workspaceId, url } },
      });
      if (existing) {
        if (existing.detachedAt) {
          await tx.workspacePR.update({
            where: { id: existing.id },
            data: {
              detachedAt: null,
              state: 'NONE',
              reviewState: null,
              ciStatus: 'UNKNOWN',
              hasMergeConflict: false,
              syncedAt: null,
              revision: { increment: 1 },
            },
          });
          await workspacePrRatchetAccessor.reset(tx, existing.id);
        }
        return { prId: existing.id, created: false, reattached: existing.detachedAt !== null };
      }
      const pr = await tx.workspacePR.create({ data: { workspaceId, url } });
      await workspacePrRatchetAccessor.create(tx, pr.id);
      return { prId: pr.id, created: true, reattached: false };
    });
  }
  detach(target: WorkspacePRIdentity) {
    return prisma.$transaction((tx) => this.detachInTransaction(tx, target));
  }
  async detachInTransaction(tx: Prisma.TransactionClient, target: WorkspacePRIdentity) {
    const result = await tx.workspacePR.updateMany({
      where: { id: target.prId, workspaceId: target.workspaceId, detachedAt: null },
      data: { detachedAt: new Date(), revision: { increment: 1 } },
    });
    return result.count > 0;
  }
  async attachDiscoveredPRsIfClaimMatches(
    workspaceId: string,
    claim: PRDiscoveryClaim,
    urls: string[]
  ) {
    return await prisma.$transaction(async (tx) => {
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
        await workspacePrRatchetAccessor.create(tx, pr.id);
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
