import type { Prisma, RatchetDispatchOutcome, WorkspaceRatchet } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import { flattenWorkspacePR } from '@/backend/services/workspace/resources/workspace-pr.accessor';
import type { CIStatus, PRState, RatchetState, WorkspaceStatus } from '@/shared/core';

/**
 * Persistence for `WorkspaceRatchet`, the ratchet's own 1:1 row per workspace.
 *
 * This file is the only writer of that table. Before the split these seven
 * fields sat on `Workspace` alongside six other concerns, and a bespoke lint
 * rule (`scripts/check-single-writer.mjs`) was what stopped other services
 * writing them. Now the type system does it: no other accessor can name these
 * columns.
 *
 * Every conditional write below guards on `enabled` and/or `state` in the same
 * statement it writes, which is why those two live here rather than staying on
 * `Workspace` — a cross-table guard would need a transaction to say what one
 * `updateMany` says now.
 */

/**
 * The ratchet fields as callers above the accessor see them: flattened onto the
 * workspace shape they already consumed, so the table split stops at this
 * boundary.
 *
 * `ratchetDispatchSnapshotKey` is the exception. On `Workspace` it was
 * `ratchetLastCiRunId`, a name its own schema comment disowned: "Misnomer (kept
 * to avoid a migration)". It has always held the full dispatch snapshot key.
 */
export interface WorkspaceRatchetFields {
  ratchetEnabled: boolean;
  ratchetState: RatchetState;
  ratchetLastCheckedAt: Date | null;
  ratchetActiveSessionId: string | null;
  ratchetDispatchSnapshotKey: string | null;
  ratchetDispatchOutcome: RatchetDispatchOutcome | null;
  ratchetDispatchRetryCount: number;
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
  ratchetState: 'IDLE',
  ratchetLastCheckedAt: null,
  ratchetActiveSessionId: null,
  ratchetDispatchSnapshotKey: null,
  ratchetDispatchOutcome: null,
  ratchetDispatchRetryCount: 0,
};

/** The persisted row, as joined onto a workspace read. */
export type WorkspaceRatchetRow = WorkspaceRatchet;

/** Flatten a joined ratchet row onto the caller-facing field names. */
export function flattenWorkspaceRatchet(
  ratchet: WorkspaceRatchet | null | undefined
): WorkspaceRatchetFields {
  if (!ratchet) {
    return { ...WORKSPACE_RATCHET_DEFAULTS };
  }
  return {
    ratchetEnabled: ratchet.enabled,
    ratchetState: ratchet.state,
    ratchetLastCheckedAt: ratchet.lastCheckedAt,
    ratchetActiveSessionId: ratchet.activeSessionId,
    ratchetDispatchSnapshotKey: ratchet.dispatchSnapshotKey,
    ratchetDispatchOutcome: ratchet.dispatchOutcome,
    ratchetDispatchRetryCount: ratchet.dispatchRetryCount,
  };
}

export interface WorkspaceForRatchet extends WorkspaceRatchetFields {
  id: string;
  prUrl: string;
  prNumber: number | null;
  prState: PRState;
  prCiStatus: CIStatus;
  defaultSessionProvider: Prisma.WorkspaceGetPayload<object>['defaultSessionProvider'];
  ratchetSessionProvider: Prisma.WorkspaceGetPayload<object>['ratchetSessionProvider'];
  prReviewLastCheckedAt: Date | null;
}

const ratchetCandidateSelect = {
  id: true,
  defaultSessionProvider: true,
  ratchetSessionProvider: true,
  ratchet: true,
  pr: true,
} satisfies Prisma.WorkspaceSelect;

type RatchetCandidateRow = Prisma.WorkspaceGetPayload<{ select: typeof ratchetCandidateSelect }>;

/**
 * Flatten a candidate row, dropping one with no PR URL.
 *
 * Every query feeding this filters on `pr: { url: { not: null } }`, so the null
 * branch is unreachable; it is here because that guarantee lives in the
 * where-clause rather than the type, and dropping the row is the honest way to
 * narrow it. (The previous version asserted the whole array's type with a cast.)
 */
function toWorkspaceForRatchet(row: RatchetCandidateRow): WorkspaceForRatchet | null {
  const { ratchet, pr, ...workspace } = row;
  const { prUrl, prNumber, prState, prCiStatus, prReviewLastCheckedAt } = flattenWorkspacePR(pr);
  if (prUrl === null) {
    return null;
  }
  return {
    ...workspace,
    prUrl,
    prNumber,
    prState,
    prCiStatus,
    prReviewLastCheckedAt,
    ...flattenWorkspaceRatchet(ratchet),
  };
}

class WorkspaceRatchetAccessor {
  /**
   * READY workspaces with PRs the ratchet should monitor, oldest check first.
   *
   * Disabled, merged and closed workspaces are filtered out to avoid pointless
   * GitHub calls. Closed PRs are excluded via the cached `prState`, kept fresh
   * by the scheduler PR sync, which also flips it back to OPEN on reopen.
   */
  async findWithPRsForRatchet(): Promise<WorkspaceForRatchet[]> {
    const rows = await prisma.workspace.findMany({
      where: {
        status: 'READY',
        pr: { url: { not: null }, state: { not: 'CLOSED' } },
        ratchet: { enabled: true, state: { not: 'MERGED' } },
      },
      select: ratchetCandidateSelect,
      orderBy: { ratchet: { lastCheckedAt: 'asc' } },
    });
    return rows
      .map(toWorkspaceForRatchet)
      .filter((row): row is WorkspaceForRatchet => row !== null);
  }

  /**
   * The four ratchet fields the snapshot stream projects, plus the lifecycle
   * status the caller checks before publishing them.
   *
   * Narrow on purpose: this runs on every ratchet event, and it used to read a
   * whole workspace row to use five of its columns.
   */
  async findSnapshotProjection(
    workspaceId: string
  ): Promise<
    | (Pick<
        WorkspaceRatchetFields,
        'ratchetEnabled' | 'ratchetState' | 'ratchetDispatchOutcome' | 'ratchetDispatchRetryCount'
      > & { status: WorkspaceStatus })
    | null
  > {
    const row = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { status: true, ratchet: true },
    });
    if (!row) {
      return null;
    }
    const { ratchetEnabled, ratchetState, ratchetDispatchOutcome, ratchetDispatchRetryCount } =
      flattenWorkspaceRatchet(row.ratchet);
    return {
      status: row.status,
      ratchetEnabled,
      ratchetState,
      ratchetDispatchOutcome,
      ratchetDispatchRetryCount,
    };
  }

  /** A single READY workspace with a PR, for ratchet processing. */
  async findForRatchetById(id: string): Promise<WorkspaceForRatchet | null> {
    const row = await prisma.workspace.findFirst({
      where: { id, status: 'READY', pr: { url: { not: null } } },
      select: ratchetCandidateSelect,
    });
    return row ? toWorkspaceForRatchet(row) : null;
  }

  /**
   * Settle the dispatch record when a fixer session ends. Conditional on the
   * pointer still naming this session, so whichever of the session-end paths
   * (lifecycle exit hook, deliberate stop, poll-check fallback) gets here first
   * wins and the others no-op — a check racing a normal exit can never
   * overwrite a COMPLETED outcome with DIED.
   */
  async recordSessionEnd(
    workspaceId: string,
    sessionId: string,
    outcome: Exclude<RatchetDispatchOutcome, 'RUNNING'>
  ): Promise<boolean> {
    const result = await prisma.workspaceRatchet.updateMany({
      where: { workspaceId, activeSessionId: sessionId },
      data: { activeSessionId: null, dispatchOutcome: outcome },
    });
    return result.count > 0;
  }

  /**
   * Record a fixer dispatch (session pointer, snapshot key, RUNNING outcome,
   * retry count) atomically, only while ratcheting is still enabled. The
   * conditional update closes the disable-vs-dispatch race where an in-flight
   * ratchet check could repopulate the active session after disable.
   */
  async recordDispatchIfEnabled(
    workspaceId: string,
    dispatch: { sessionId: string; snapshotKey: string; retryCount: number }
  ): Promise<boolean> {
    const result = await prisma.workspaceRatchet.updateMany({
      where: { workspaceId, enabled: true },
      data: {
        activeSessionId: dispatch.sessionId,
        dispatchSnapshotKey: dispatch.snapshotKey,
        dispatchOutcome: 'RUNNING',
        dispatchRetryCount: dispatch.retryCount,
      },
    });
    return result.count > 0;
  }

  /**
   * Adopt an already-running fixer session as the active session without
   * recording a new dispatch: the snapshot key and retry count are left alone,
   * since no prompt was sent for the current PR state.
   */
  async adoptActiveSessionIfEnabled(workspaceId: string, sessionId: string): Promise<boolean> {
    const result = await prisma.workspaceRatchet.updateMany({
      where: { workspaceId, enabled: true },
      data: { activeSessionId: sessionId, dispatchOutcome: 'RUNNING' },
    });
    return result.count > 0;
  }

  /**
   * Compare-and-swap state transition, mirroring `transitionWithCas`. Persists
   * only while ratcheting remains enabled AND the state still matches the one
   * the caller observed, so stale in-flight checks can neither overwrite the
   * disabled state nor a concurrent transition, and emitted `fromState` values
   * are accurate by construction. Transition validity is checked by the caller
   * against RATCHET_VALID_TRANSITIONS (see `ratchet-state-machine.ts`).
   */
  async transitionStateIfEnabled(
    workspaceId: string,
    fromState: RatchetState,
    data: { ratchetState: RatchetState; ratchetLastCheckedAt: Date }
  ): Promise<boolean> {
    const result = await prisma.workspaceRatchet.updateMany({
      where: { workspaceId, enabled: true, state: fromState },
      data: { state: data.ratchetState, lastCheckedAt: data.ratchetLastCheckedAt },
    });
    return result.count > 0;
  }

  /**
   * Settle state to IDLE for a workspace whose ratcheting is disabled, CAS on
   * the observed `fromState`. The disabled condition keeps this write from
   * clobbering a concurrent re-enable; the `fromState` condition keeps the
   * emitted transition accurate.
   */
  async settleIdleWhileDisabled(workspaceId: string, fromState: RatchetState): Promise<boolean> {
    const result = await prisma.workspaceRatchet.updateMany({
      where: { workspaceId, enabled: false, state: fromState },
      data: { state: 'IDLE', lastCheckedAt: new Date() },
    });
    return result.count > 0;
  }

  /**
   * Release the active-session pointer, if it still names this session.
   *
   * Session-scoped for the same reason `recordSessionEnd` is. Its only caller is
   * the prompt-delivery failure path, which returns before recording its own
   * dispatch — so the pointer it would otherwise clear belongs to a different
   * dispatch, and an unscoped clear would evict that claim.
   */
  async clearActiveSession(workspaceId: string, sessionId: string): Promise<boolean> {
    const result = await prisma.workspaceRatchet.updateMany({
      where: { workspaceId, activeSessionId: sessionId },
      data: { activeSessionId: null },
    });
    return result.count > 0;
  }

  async enable(workspaceId: string): Promise<void> {
    await prisma.workspaceRatchet.updateMany({ where: { workspaceId }, data: { enabled: true } });
  }

  /**
   * Disable ratcheting and clear everything the ratchet was tracking, so a
   * later re-enable starts from a clean progression rather than resuming a
   * dispatch whose session is gone.
   */
  async disable(workspaceId: string): Promise<void> {
    await prisma.workspaceRatchet.updateMany({
      where: { workspaceId },
      data: {
        enabled: false,
        state: 'IDLE',
        activeSessionId: null,
        dispatchSnapshotKey: null,
        dispatchOutcome: null,
        dispatchRetryCount: 0,
      },
    });
  }

  /**
   * Read the dispatch metadata a PR-aggregate write needs in order to decide
   * whether the dispatch it settled is now stale. Runs inside the caller's
   * transaction so the value it returns is the one `resetSettledDispatch`
   * guards against.
   */
  async readDispatchGuard(
    transaction: Prisma.TransactionClient,
    workspaceId: string
  ): Promise<Pick<
    WorkspaceRatchet,
    'activeSessionId' | 'dispatchSnapshotKey' | 'dispatchOutcome' | 'dispatchRetryCount'
  > | null> {
    return await transaction.workspaceRatchet.findUnique({
      where: { workspaceId },
      select: {
        activeSessionId: true,
        dispatchSnapshotKey: true,
        dispatchOutcome: true,
        dispatchRetryCount: true,
      },
    });
  }

  /**
   * Release a settled dispatch's claim on the current PR state, CAS on the
   * metadata the caller read. If a newer dispatch won that race the guard fails
   * and the claim is preserved; RUNNING dispatches are never passed here.
   */
  async resetSettledDispatch(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
    guard: Pick<
      WorkspaceRatchet,
      'activeSessionId' | 'dispatchSnapshotKey' | 'dispatchOutcome' | 'dispatchRetryCount'
    >
  ): Promise<boolean> {
    const result = await transaction.workspaceRatchet.updateMany({
      where: { workspaceId, ...guard },
      data: { dispatchOutcome: null, dispatchRetryCount: 0 },
    });
    return result.count > 0;
  }
}

export const workspaceRatchetAccessor = new WorkspaceRatchetAccessor();
