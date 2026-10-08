import type {
  Prisma,
  RatchetDispatchOutcome,
  WorkspacePRRatchet,
  WorkspaceRatchet,
} from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import { type CIStatus, deriveRatchetState, type PRState, type RatchetState } from '@/shared/core';
import { deriveWorkspacePRSummary } from '@/shared/workspace-pr-summary';
import { flattenWorkspacePR, serializeWorkspacePR } from './workspace-pr.accessor';
import { type PRDispatchGuard, workspacePrRatchetAccessor } from './workspace-pr-ratchet.accessor';

export interface WorkspaceRatchetFields {
  ratchetEnabled: boolean;
  ratchetLastCheckedAt: Date | null;
  ratchetActiveSessionId: string | null;
  ratchetDispatchSnapshotKey: string | null;
  ratchetDispatchOutcome: RatchetDispatchOutcome | null;
  ratchetDispatchRetryCount: number;
  ratchetDispatchStalled: boolean;
}

/**
 * What a workspace with no ratchet row reads as. Matches the column defaults,
 * so this is the same answer the old `Workspace` columns gave a freshly created
 * row.
 *
 * A row is created with every workspace (see `workspaceAccessor.create`) and the
 * split migration backfilled every existing one, so this is a fallback for data
 * that arrived by another route — a pre-split backup restored, say — not an
 * expected state.
 */
export const WORKSPACE_RATCHET_DEFAULTS: WorkspaceRatchetFields = {
  ratchetEnabled: true,
  ratchetLastCheckedAt: null,
  ratchetActiveSessionId: null,
  ratchetDispatchSnapshotKey: null,
  ratchetDispatchOutcome: null,
  ratchetDispatchRetryCount: 0,
  ratchetDispatchStalled: false,
};

/** The persisted row, as joined onto a workspace read. */
export type WorkspaceRatchetRow = WorkspaceRatchet;

/** Workspace ownership plus the dispatch history for an explicit PR. */
export function flattenWorkspaceRatchet(
  ratchet: WorkspaceRatchet | null | undefined,
  dispatch?: WorkspacePRRatchet | null
): WorkspaceRatchetFields {
  return {
    ratchetEnabled: ratchet?.enabled ?? true,
    ratchetLastCheckedAt: ratchet?.lastCheckedAt ?? null,
    ratchetActiveSessionId: ratchet?.activeSessionId ?? null,
    ratchetDispatchSnapshotKey: dispatch?.dispatchSnapshotKey ?? null,
    ratchetDispatchOutcome: dispatch?.dispatchOutcome ?? null,
    ratchetDispatchRetryCount: dispatch?.dispatchRetryCount ?? 0,
    ratchetDispatchStalled: dispatch?.dispatchStalled ?? false,
  };
}

export interface WorkspaceForRatchet extends WorkspaceRatchetFields {
  id: string;
  prId: string;
  prRevision: number;
  prHeadRefName: string | null;
  ratchetActivePrId: string | null;
  prUrl: string;
  prNumber: number | null;
  prState: PRState;
  prReviewState: string | null;
  prCiStatus: CIStatus;
  prHasMergeConflict: boolean;
  /** Derived, not stored. See `deriveRatchetState`. */
  ratchetState: RatchetState;
  defaultSessionProvider: Prisma.WorkspaceGetPayload<object>['defaultSessionProvider'];
  ratchetSessionProvider: Prisma.WorkspaceGetPayload<object>['ratchetSessionProvider'];
  prReviewLastCheckedAt: Date | null;
}

const candidateSelect = {
  id: true,
  defaultSessionProvider: true,
  ratchetSessionProvider: true,
  ratchet: true,
  prs: { where: { detachedAt: null }, include: { automation: true } },
} satisfies Prisma.WorkspaceSelect;
type CandidateRow = Prisma.WorkspaceGetPayload<{ select: typeof candidateSelect }>;
function candidates(row: CandidateRow): WorkspaceForRatchet[] {
  return [...row.prs]
    .sort(
      (a, b) =>
        (a.automation?.lastCheckedAt?.getTime() ?? 0) -
          (b.automation?.lastCheckedAt?.getTime() ?? 0) || a.id.localeCompare(b.id)
    )
    .map((pr) => {
      const fields = flattenWorkspacePR(pr);
      const ratchet = flattenWorkspaceRatchet(row.ratchet, pr.automation);
      return {
        id: row.id,
        defaultSessionProvider: row.defaultSessionProvider,
        ratchetSessionProvider: row.ratchetSessionProvider,
        ...fields,
        prUrl: pr.url,
        prId: pr.id,
        prRevision: pr.revision,
        prHeadRefName: pr.headRefName,
        ...ratchet,
        ratchetActiveSessionId:
          row.ratchet?.activePrId === pr.id ? row.ratchet.activeSessionId : null,
        ratchetActivePrId: row.ratchet?.activePrId ?? null,
        ratchetState: deriveRatchetState({ ...fields, ratchetEnabled: ratchet.ratchetEnabled }),
      };
    });
}
class WorkspaceRatchetAccessor {
  restoreOwnership(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    activePrId: string,
    activeSessionId: string | null
  ) {
    return tx.workspaceRatchet.update({
      where: { workspaceId },
      data: { activePrId, activeSessionId },
    });
  }

  async findWithPRsForRatchet(): Promise<WorkspaceForRatchet[]> {
    const rows = await prisma.workspace.findMany({
      where: {
        status: 'READY',
        ratchet: { enabled: true },
        prs: { some: { detachedAt: null, state: { notIn: ['CLOSED', 'MERGED'] } } },
      },
      select: candidateSelect,
      orderBy: { ratchet: { lastCheckedAt: 'asc' } },
    });
    return rows
      .flatMap(candidates)
      .filter((pr) => pr.prState !== 'CLOSED' && pr.prState !== 'MERGED');
  }
  async findForRatchetById(id: string, prId?: string): Promise<WorkspaceForRatchet | null> {
    const row = await prisma.workspace.findFirst({
      where: { id, status: 'READY' },
      select: candidateSelect,
    });
    if (!row) {
      return null;
    }
    const prs = candidates(row);
    return (
      (prId ? prs.find((pr) => pr.prId === prId) : prs.length === 1 ? prs[0] : undefined) ?? null
    );
  }
  async findAllForRatchetById(id: string): Promise<WorkspaceForRatchet[]> {
    const row = await prisma.workspace.findFirst({
      where: { id, status: 'READY' },
      select: candidateSelect,
    });
    return row ? candidates(row) : [];
  }
  async findSnapshotProjection(workspaceId: string) {
    const row = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { status: true, ...candidateSelect },
    });
    if (!row) {
      return null;
    }
    const prs = row.prs.map(serializeWorkspacePR);
    const summary = deriveWorkspacePRSummary(prs, row.ratchet?.enabled ?? true);
    return {
      status: row.status,
      prs,
      prSummary: summary,
      prState: summary.state,
      prCiStatus: summary.ciStatus,
      prUrl: prs.length === 1 ? (prs[0]?.url ?? null) : null,
      prNumber: prs.length === 1 ? (prs[0]?.number ?? null) : null,
      prUpdatedAt: row.prs.reduce<Date | null>(
        (latest, pr) => (pr.syncedAt && (!latest || pr.syncedAt > latest) ? pr.syncedAt : latest),
        null
      ),
      ratchetEnabled: row.ratchet?.enabled ?? true,
      ratchetState: summary.ratchetState,
      ratchetDispatchOutcome: row.ratchet?.activeSessionId
        ? ('RUNNING' as RatchetDispatchOutcome)
        : null,
      ratchetDispatchRetryCount: 0,
      ratchetDispatchStalled: summary.dispatchStalled,
      prHasMergeConflict: summary.hasMergeConflict,
    };
  }

  async recordSessionEnd(
    workspaceId: string,
    sessionId: string,
    outcome: Exclude<RatchetDispatchOutcome, 'RUNNING'>
  ): Promise<boolean> {
    return await prisma.$transaction(async (tx) => {
      const slot = await tx.workspaceRatchet.findUnique({ where: { workspaceId } });
      if (!slot?.activePrId || slot.activeSessionId !== sessionId) {
        return false;
      }
      const cleared = await tx.workspaceRatchet.updateMany({
        where: { workspaceId, activePrId: slot.activePrId, activeSessionId: sessionId },
        data: { activeSessionId: null, activePrId: null },
      });
      if (!cleared.count) {
        return false;
      }
      await workspacePrRatchetAccessor.settle(tx, slot.activePrId, sessionId, outcome);
      return true;
    });
  }
  async recordDispatchIfEnabled(
    workspaceId: string,
    dispatch: {
      sessionId: string;
      snapshotKey: string;
      retryCount: number;
      prId?: string;
      expectedRevision?: number;
    }
  ): Promise<boolean> {
    return await prisma.$transaction(async (tx) => {
      const prs = await tx.workspacePR.findMany({
        where: {
          workspaceId,
          detachedAt: null,
          state: { notIn: ['MERGED', 'CLOSED'] },
          workspace: { status: 'READY' },
          ...(dispatch.expectedRevision !== undefined
            ? { revision: dispatch.expectedRevision }
            : {}),
          ...(dispatch.prId ? { id: dispatch.prId } : {}),
        },
        take: 2,
      });
      const pr = prs.length === 1 ? prs[0] : undefined;
      if (!pr) {
        return false;
      }
      const claim = await tx.workspaceRatchet.updateMany({
        where: {
          workspaceId,
          enabled: true,
          OR: [
            { activeSessionId: null },
            { activeSessionId: dispatch.sessionId, activePrId: pr.id },
          ],
        },
        data: { activeSessionId: dispatch.sessionId, activePrId: pr.id },
      });
      if (!claim.count) {
        return false;
      }
      await workspacePrRatchetAccessor.recordDispatch(tx, pr.id, dispatch);
      return true;
    });
  }
  async releaseDetachedPR(tx: Prisma.TransactionClient, workspaceId: string, prId: string) {
    const slot = await tx.workspaceRatchet.findUnique({ where: { workspaceId } });
    if (slot?.activePrId !== prId || !slot.activeSessionId) {
      return null;
    }
    await tx.workspaceRatchet.updateMany({
      where: { workspaceId, activePrId: prId, activeSessionId: slot.activeSessionId },
      data: { activePrId: null, activeSessionId: null },
    });
    await workspacePrRatchetAccessor.settle(tx, prId, slot.activeSessionId, 'COMPLETED');
    return slot.activeSessionId;
  }
  async adoptActiveSessionIfEnabled(
    workspaceId: string,
    sessionId: string,
    prId?: string
  ): Promise<boolean> {
    if (!prId) {
      return false;
    }
    return await prisma.$transaction(async (tx) => {
      const slot = await tx.workspaceRatchet.findUnique({ where: { workspaceId } });
      if (!slot?.enabled || slot.activePrId !== prId || slot.activeSessionId !== sessionId) {
        return false;
      }
      return true;
    });
  }
  async recordCheckIfEnabled(
    workspaceId: string,
    checkedAt: Date,
    prId?: string
  ): Promise<boolean> {
    return await prisma.$transaction(async (tx) => {
      const result = await tx.workspaceRatchet.updateMany({
        where: { workspaceId, enabled: true },
        data: { lastCheckedAt: checkedAt },
      });
      if (result.count && prId) {
        await workspacePrRatchetAccessor.recordCheck(tx, prId, checkedAt);
      }
      return result.count > 0;
    });
  }
  clearActiveSession(workspaceId: string, sessionId: string) {
    return this.recordSessionEnd(workspaceId, sessionId, 'DIED');
  }
  async markDispatchStalled(
    workspaceId: string,
    snapshotKey: string,
    prId?: string
  ): Promise<boolean> {
    if (!prId) {
      return false;
    }
    return await workspacePrRatchetAccessor.markDispatchStalled(workspaceId, prId, snapshotKey);
  }
  async enable(workspaceId: string): Promise<void> {
    await prisma.workspaceRatchet.updateMany({ where: { workspaceId }, data: { enabled: true } });
  }
  async disable(workspaceId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.workspaceRatchet.updateMany({
        where: { workspaceId },
        data: { enabled: false, activeSessionId: null, activePrId: null },
      });
      await workspacePrRatchetAccessor.resetForWorkspace(tx, workspaceId);
    });
  }
  async readDispatchGuard(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    prId?: string
  ): Promise<PRDispatchGuard | null> {
    if (!prId) {
      const prs = await tx.workspacePR.findMany({
        where: { workspaceId, detachedAt: null },
        take: 2,
      });
      if (prs.length !== 1 || !prs[0]) {
        return null;
      }
      prId = prs[0].id;
    }
    return workspacePrRatchetAccessor.read(tx, prId);
  }
  async resetSettledDispatch(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    guard: PRDispatchGuard,
    prId?: string
  ): Promise<boolean> {
    if (!prId) {
      const prs = await tx.workspacePR.findMany({
        where: { workspaceId, detachedAt: null },
        take: 2,
      });
      if (prs.length !== 1 || !prs[0]) {
        return false;
      }
      prId = prs[0].id;
    }
    return workspacePrRatchetAccessor.reset(tx, prId, guard);
  }
}
export const workspaceRatchetAccessor = new WorkspaceRatchetAccessor();
