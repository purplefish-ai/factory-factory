import type { Prisma, RatchetDispatchOutcome, WorkspaceRatchet } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import { flattenWorkspacePR } from '@/backend/services/workspace/resources/workspace-pr.accessor';
import {
  type CIStatus,
  deriveRatchetState,
  type PRState,
  type RatchetState,
  type WorkspaceStatus,
} from '@/shared/core';

/**
 * Persistence for `WorkspaceRatchet`, the ratchet's own 1:1 row per workspace.
 *
 * This file is the only writer of that table after creation, enforced by the
 * owned-side-table rule in `scripts/check-single-writer.mjs`; the row is created
 * with its workspace by `workspaceAccessor.create`, which sets `enabled`. Before the split these fields sat on
 * `Workspace` alongside six other concerns, policed field-by-field by that same
 * script.
 *
 * `state` is no longer among them. It was a projection of the PR observation, so
 * it is computed by `deriveRatchetState` at the point of reading and there is
 * nothing here to keep in step with `WorkspacePR`. What is left is genuinely
 * mutable — the toggle and the dispatch record — and every conditional write
 * below guards on `enabled` in the same statement it writes, which is why the
 * toggle lives next to the dispatch record.
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

/** Flatten a joined ratchet row onto the caller-facing field names. */
export function flattenWorkspaceRatchet(
  ratchet: WorkspaceRatchet | null | undefined
): WorkspaceRatchetFields {
  if (!ratchet) {
    return { ...WORKSPACE_RATCHET_DEFAULTS };
  }
  return {
    ratchetEnabled: ratchet.enabled,
    ratchetLastCheckedAt: ratchet.lastCheckedAt,
    ratchetActiveSessionId: ratchet.activeSessionId,
    ratchetDispatchSnapshotKey: ratchet.dispatchSnapshotKey,
    ratchetDispatchOutcome: ratchet.dispatchOutcome,
    ratchetDispatchRetryCount: ratchet.dispatchRetryCount,
    ratchetDispatchStalled: ratchet.dispatchStalled,
  };
}

export interface WorkspaceForRatchet extends WorkspaceRatchetFields {
  id: string;
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
  const {
    prUrl,
    prNumber,
    prState,
    prReviewState,
    prCiStatus,
    prHasMergeConflict,
    prReviewLastCheckedAt,
  } = flattenWorkspacePR(pr);
  if (prUrl === null) {
    return null;
  }
  const ratchetFields = flattenWorkspaceRatchet(ratchet);
  return {
    ...workspace,
    prUrl,
    prNumber,
    prState,
    prReviewState,
    prCiStatus,
    prHasMergeConflict,
    prReviewLastCheckedAt,
    ...ratchetFields,
    ratchetState: deriveRatchetState({
      ratchetEnabled: ratchetFields.ratchetEnabled,
      prState,
      prCiStatus,
      prHasMergeConflict,
      prReviewState,
    }),
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
        // Closed and merged PRs are both skipped on the cached `prState`. That
        // used to be two conditions -- `pr.state != CLOSED` and
        // `ratchet.state != MERGED` -- reading the same fact from two tables
        // that could disagree about it.
        pr: { url: { not: null }, state: { notIn: ['CLOSED', 'MERGED'] } },
        ratchet: { enabled: true },
      },
      select: ratchetCandidateSelect,
      orderBy: { ratchet: { lastCheckedAt: 'asc' } },
    });
    return rows
      .map(toWorkspaceForRatchet)
      .filter((row): row is WorkspaceForRatchet => row !== null);
  }

  /**
   * The ratchet fields the snapshot stream projects, plus `prHasMergeConflict`
   * (read off the joined PR row so the ratchet and PR field-groups both refresh
   * from the same event) and the lifecycle status the caller checks before
   * publishing them.
   *
   * Narrow on purpose: this runs on every ratchet event, and it used to read a
   * whole workspace row to use five of its columns.
   */
  async findSnapshotProjection(workspaceId: string): Promise<
    | (Pick<
        WorkspaceRatchetFields,
        | 'ratchetEnabled'
        | 'ratchetDispatchOutcome'
        | 'ratchetDispatchRetryCount'
        | 'ratchetDispatchStalled'
      > & {
        ratchetState: RatchetState;
        status: WorkspaceStatus;
        prHasMergeConflict: boolean;
      })
    | null
  > {
    const row = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      // `pr` joins in because the projected state is derived from it. Still
      // narrow: two 1:1 rows rather than the whole workspace.
      select: { status: true, ratchet: true, pr: true },
    });
    if (!row) {
      return null;
    }
    const {
      ratchetEnabled,
      ratchetDispatchOutcome,
      ratchetDispatchRetryCount,
      ratchetDispatchStalled,
    } = flattenWorkspaceRatchet(row.ratchet);
    const { prState, prCiStatus, prHasMergeConflict, prReviewState } = flattenWorkspacePR(row.pr);
    return {
      status: row.status,
      ratchetEnabled,
      ratchetState: deriveRatchetState({
        ratchetEnabled,
        prState,
        prCiStatus,
        prHasMergeConflict,
        prReviewState,
      }),
      ratchetDispatchOutcome,
      ratchetDispatchRetryCount,
      ratchetDispatchStalled,
      prHasMergeConflict,
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
        // A dispatch is the ratchet acting, so it cannot still be stalled.
        // `resetSettledDispatch` clears the flag when a PR observation changes
        // the cached aggregate, but the dispatch snapshot key also hashes
        // `statusCheckRollup` detail that `WorkspacePR` does not store — so a
        // re-run that keeps CI at FAILURE changes the key, warrants a fresh
        // dispatch, and never touches the aggregate. Clearing it here keeps the
        // flag scoped to the dispatch it describes.
        dispatchStalled: false,
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
   * Stamp the check timestamp, only while ratcheting is still enabled.
   *
   * Returning false is how a check learns it was disabled while it ran, which is
   * the one thing the old state CAS detected that still matters. The state
   * half of that CAS is gone with the column: there is no stored value left for
   * a stale check to overwrite, and the `fromState` it protected on
   * `RATCHET_STATE_CHANGED` is now computed from the row the emitter read.
   */
  async recordCheckIfEnabled(workspaceId: string, checkedAt: Date): Promise<boolean> {
    const result = await prisma.workspaceRatchet.updateMany({
      where: { workspaceId, enabled: true },
      data: { lastCheckedAt: checkedAt },
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

  /**
   * Record that the ratchet has concluded it will not act again for the current
   * PR state. Cleared by `resetSettledDispatch`, `disable`, and the next
   * dispatch, which already own the rest of the dispatch record's lifecycle.
   *
   * A compare-and-swap, like every other write on this row, rather than an
   * update by workspace id. A ratchet check runs concurrently with PR sync, so
   * between the decision and this write the dispatch it reasoned about can be
   * reset by a newer observation or cleared by a disable — and an unguarded
   * write would resurrect a stall conclusion for a dispatch that no longer
   * exists. Matching on `dispatchSnapshotKey` pins the write to the dispatch the
   * check actually evaluated.
   *
   * Returns whether this call is what flipped the flag. `dispatchStalled: false`
   * in the guard is what makes that true exactly once: the ratchet re-reaches
   * this conclusion on every poll for as long as the PR sits unchanged, and only
   * the first of those is a transition worth republishing.
   */
  async markDispatchStalled(workspaceId: string, snapshotKey: string): Promise<boolean> {
    const result = await prisma.workspaceRatchet.updateMany({
      where: {
        workspaceId,
        enabled: true,
        dispatchSnapshotKey: snapshotKey,
        dispatchStalled: false,
      },
      data: { dispatchStalled: true },
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
        activeSessionId: null,
        dispatchSnapshotKey: null,
        dispatchOutcome: null,
        dispatchRetryCount: 0,
        dispatchStalled: false,
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
      data: { dispatchOutcome: null, dispatchRetryCount: 0, dispatchStalled: false },
    });
    return result.count > 0;
  }
}

export const workspaceRatchetAccessor = new WorkspaceRatchetAccessor();
