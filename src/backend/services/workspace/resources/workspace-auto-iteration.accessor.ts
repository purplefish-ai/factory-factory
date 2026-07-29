import type { Prisma, WorkspaceAutoIteration } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import type { AutoIterationStatus, WorkspaceMode } from '@/shared/core';

/**
 * Persistence for `WorkspaceAutoIteration`, the mode discriminant and the
 * auto-iteration loop's state.
 *
 * This file is the only writer of that table after creation -- the row is
 * created with its workspace by `workspaceAccessor.create`, which sets `mode`
 * and `config`. Before the split these five
 * columns sat on `Workspace` and `scripts/check-single-writer.mjs` was what kept
 * them to their two writers; now no other accessor can name the columns.
 *
 * Callers still speak in the flat `mode`/`autoIteration*` names, because `mode`
 * and `autoIterationConfig` are in the v4 export format and all five are read
 * through the workspace list. The mapping to the unprefixed column names happens
 * here and nowhere else.
 */

/**
 * The auto-iteration group as callers above the accessor see it: flattened onto
 * the workspace shape they already consumed, so the table split stops here.
 */
export interface WorkspaceAutoIterationFields {
  mode: WorkspaceMode;
  autoIterationStatus: AutoIterationStatus | null;
  autoIterationConfig: Prisma.JsonValue | null;
  autoIterationProgress: Prisma.JsonValue | null;
  autoIterationSessionId: string | null;
}

/**
 * What a workspace with no auto-iteration row reads as. Matches the column
 * defaults, so it is the same answer the old `Workspace` columns gave a freshly
 * created row — `STANDARD` and four nulls, which is what 100% of rows looked
 * like on the database this split was developed against.
 *
 * A row is created with every workspace (see `workspaceAccessor.create`) and the
 * split migration backfilled every existing one, so this covers data that
 * arrived by another route — a pre-split backup restored, say — rather than an
 * expected state.
 */
export const WORKSPACE_AUTO_ITERATION_DEFAULTS: WorkspaceAutoIterationFields = {
  mode: 'STANDARD',
  autoIterationStatus: null,
  autoIterationConfig: null,
  autoIterationProgress: null,
  autoIterationSessionId: null,
};

/** Flatten a joined auto-iteration row onto the caller-facing field names. */
export function flattenWorkspaceAutoIteration(
  autoIteration: WorkspaceAutoIteration | null | undefined
): WorkspaceAutoIterationFields {
  if (!autoIteration) {
    return { ...WORKSPACE_AUTO_ITERATION_DEFAULTS };
  }
  return {
    mode: autoIteration.mode,
    autoIterationStatus: autoIteration.status,
    autoIterationConfig: autoIteration.config,
    autoIterationProgress: autoIteration.progress,
    autoIterationSessionId: autoIteration.sessionId,
  };
}

class WorkspaceAutoIterationAccessor {
  /**
   * Write to a row that must exist. `updateMany` rather than `update` so a
   * missing row surfaces as a count of zero we can name, instead of a Prisma
   * error naming a table the caller does not know about.
   */
  private async write(
    workspaceId: string,
    data: Prisma.WorkspaceAutoIterationUpdateManyMutationInput
  ): Promise<void> {
    const result = await prisma.workspaceAutoIteration.updateMany({
      where: { workspaceId },
      data,
    });
    if (result.count === 0) {
      throw new Error(`WorkspaceAutoIteration row not found for workspace: ${workspaceId}`);
    }
  }

  /**
   * Set the loop's status and report the row it landed on.
   *
   * Returns `mode` alongside the status because the caller publishes both to the
   * snapshot stream, and the stream's own copy of `mode` is otherwise only
   * seeded by the reconciliation sweep — so a loop that reaches a gap between
   * iterations inside that window would be derived against a `STANDARD` it never
   * had. Reading it back from the written row costs one narrow query on a
   * transition that happens a handful of times per iteration.
   */
  async setStatus(
    workspaceId: string,
    status: AutoIterationStatus
  ): Promise<{ mode: WorkspaceMode; status: AutoIterationStatus }> {
    await this.write(workspaceId, { status });
    return { mode: await this.readMode(workspaceId), status };
  }

  /**
   * `mode` for a row this accessor has just written, so callers never infer it
   * from the fact that an auto-iteration code path is running.
   */
  private async readMode(workspaceId: string): Promise<WorkspaceMode> {
    const row = await prisma.workspaceAutoIteration.findUnique({
      where: { workspaceId },
      select: { mode: true },
    });
    return row?.mode ?? WORKSPACE_AUTO_ITERATION_DEFAULTS.mode;
  }

  setProgress(workspaceId: string, progress: Prisma.InputJsonValue): Promise<void> {
    return this.write(workspaceId, { progress });
  }

  setSession(workspaceId: string, sessionId: string | null): Promise<void> {
    return this.write(workspaceId, { sessionId });
  }

  /**
   * Settle the loop, but only if the session that is settling it is still the
   * one on the row. A recycled or restarted session must not stamp its outcome
   * over a loop that has already moved on.
   */
  async finishIfSessionMatches(
    workspaceId: string,
    sessionId: string,
    status: AutoIterationStatus
  ): Promise<{ settled: boolean; mode: WorkspaceMode | null }> {
    const result = await prisma.workspaceAutoIteration.updateMany({
      where: { workspaceId, sessionId },
      data: { status, sessionId: null },
    });
    if (result.count !== 1) {
      return { settled: false, mode: null };
    }
    // Only read the mode on the branch that actually settled: a compare-and-swap
    // that matched nothing has no transition to publish.
    return { settled: true, mode: await this.readMode(workspaceId) };
  }

  async clearSessionIfMatches(workspaceId: string, sessionId: string): Promise<boolean> {
    const result = await prisma.workspaceAutoIteration.updateMany({
      where: { workspaceId, sessionId },
      data: { sessionId: null },
    });
    return result.count === 1;
  }

  /**
   * Reset loops left RUNNING by a crash or restart to FAILED, and report which
   * workspaces were actually reset so the caller can emit a status change per row.
   *
   * FAILED rather than PAUSED: the in-memory loop context does not survive a
   * restart, so there is nothing to resume. Only RUNNING is swept — PAUSED is a
   * state the user chose, and COMPLETED/FAILED are results they have not seen.
   *
   * The sweep reads and writes in two steps, so each write is guarded on the
   * `sessionId` its row was observed with, not just on RUNNING. Without that, a
   * loop started between the read and the write is RUNNING under a *new* session
   * when the write lands, and a blanket `status: 'RUNNING'` update would fail a
   * loop that is alive — the same race the two session compare-and-swaps above
   * exist to prevent. A guard that does not match leaves the row alone and keeps
   * it out of the returned list, so no status-changed event is emitted for a
   * workspace this did not touch.
   */
  async resetStaleRunningStatuses(): Promise<Array<{ id: string }>> {
    const stale = await prisma.workspaceAutoIteration.findMany({
      where: { status: 'RUNNING' },
      select: { workspaceId: true, sessionId: true },
    });

    if (stale.length === 0) {
      return [];
    }

    const outcomes = await Promise.all(
      stale.map(async (row) => {
        const result = await prisma.workspaceAutoIteration.updateMany({
          where: { workspaceId: row.workspaceId, status: 'RUNNING', sessionId: row.sessionId },
          data: { status: 'FAILED', sessionId: null },
        });
        // Callers keyed off `id` before the split and still do.
        return result.count === 1 ? { id: row.workspaceId } : null;
      })
    );

    return outcomes.filter((outcome) => outcome !== null);
  }
}

export const workspaceAutoIterationAccessor = new WorkspaceAutoIterationAccessor();
