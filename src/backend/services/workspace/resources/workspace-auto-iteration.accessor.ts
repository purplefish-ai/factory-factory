import type { Prisma, WorkspaceAutoIteration } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import type { AutoIterationStatus, WorkspaceMode } from '@/shared/core';

/**
 * Persistence for `WorkspaceAutoIteration`, the mode discriminant and the
 * auto-iteration loop's state.
 *
 * This file is the only writer of that table. Before the split these five
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

  setStatus(workspaceId: string, status: AutoIterationStatus): Promise<void> {
    return this.write(workspaceId, { status });
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
  ): Promise<boolean> {
    const result = await prisma.workspaceAutoIteration.updateMany({
      where: { workspaceId, sessionId },
      data: { status, sessionId: null },
    });
    return result.count === 1;
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
   * workspaces they were so the caller can emit a status change per row.
   *
   * FAILED rather than PAUSED: the in-memory loop context does not survive a
   * restart, so there is nothing to resume. Only RUNNING is swept — PAUSED is a
   * state the user chose, and COMPLETED/FAILED are results they have not seen.
   */
  async resetStaleRunningStatuses(): Promise<Array<{ id: string }>> {
    const stale = await prisma.workspaceAutoIteration.findMany({
      where: { status: 'RUNNING' },
      select: { workspaceId: true },
    });

    if (stale.length === 0) {
      return [];
    }

    await prisma.workspaceAutoIteration.updateMany({
      where: {
        workspaceId: { in: stale.map((row) => row.workspaceId) },
        status: 'RUNNING',
      },
      data: {
        status: 'FAILED',
        sessionId: null,
      },
    });

    // Callers keyed off `id` before the split and still do.
    return stale.map((row) => ({ id: row.workspaceId }));
  }
}

export const workspaceAutoIterationAccessor = new WorkspaceAutoIterationAccessor();
