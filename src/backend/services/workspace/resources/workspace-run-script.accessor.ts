import type { Prisma, WorkspaceRunScript } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import type { RunScriptStatus } from '@/shared/core';

/**
 * Persistence for `WorkspaceRunScript`, the cached run-script commands and the
 * process running one of them.
 *
 * This file is the only writer of that table after creation -- the row is
 * created, empty, with its workspace by `workspaceAccessor.create`. Before the
 * split these seven
 * columns sat on `Workspace` and `scripts/check-single-writer.mjs` was what kept
 * them to one writer; now no other accessor can name the columns.
 *
 * Callers still speak in the flat `runScript*` names the columns had, because
 * `runScriptStatus` reaches the snapshot wire, the v4 export format and the
 * kanban card, and the four runtime names are the shape the run-script state
 * machine passes around. The mapping to the unprefixed column names happens here
 * and nowhere else.
 */

/**
 * The run-script group as callers above the accessor see it: flattened onto the
 * workspace shape they already consumed, so the table split stops here.
 */
export interface WorkspaceRunScriptFields {
  runScriptCommand: string | null;
  runScriptPostRunCommand: string | null;
  runScriptCleanupCommand: string | null;
  runScriptPid: number | null;
  runScriptPort: number | null;
  runScriptStartedAt: Date | null;
  runScriptStatus: RunScriptStatus;
}

/**
 * What a workspace with no run-script row reads as. Matches the column defaults,
 * so it is the same answer the old `Workspace` columns gave a freshly created
 * row.
 *
 * A row is created with every workspace (see `workspaceAccessor.create`) and the
 * split migration backfilled every existing one, so this covers data that
 * arrived by another route — a pre-split backup restored, say — rather than an
 * expected state.
 */
export const WORKSPACE_RUN_SCRIPT_DEFAULTS: WorkspaceRunScriptFields = {
  runScriptCommand: null,
  runScriptPostRunCommand: null,
  runScriptCleanupCommand: null,
  runScriptPid: null,
  runScriptPort: null,
  runScriptStartedAt: null,
  runScriptStatus: 'IDLE',
};

/** The persisted row, as joined onto a workspace read. */
export type WorkspaceRunScriptRow = WorkspaceRunScript;

/** Flatten a joined run-script row onto the caller-facing field names. */
export function flattenWorkspaceRunScript(
  runScript: WorkspaceRunScript | null | undefined
): WorkspaceRunScriptFields {
  if (!runScript) {
    return { ...WORKSPACE_RUN_SCRIPT_DEFAULTS };
  }
  return {
    runScriptCommand: runScript.command,
    runScriptPostRunCommand: runScript.postRunCommand,
    runScriptCleanupCommand: runScript.cleanupCommand,
    runScriptPid: runScript.pid,
    runScriptPort: runScript.port,
    runScriptStartedAt: runScript.startedAt,
    runScriptStatus: runScript.status,
  };
}

/** The subset of the group a caller may write in one update. */
export type WorkspaceRunScriptWriteFields = Partial<WorkspaceRunScriptFields>;

/** The four columns describing the process, as a read returns them. */
export type RunScriptExecutionFields = Pick<
  WorkspaceRunScriptFields,
  'runScriptStatus' | 'runScriptPid' | 'runScriptPort' | 'runScriptStartedAt'
>;

/**
 * The same four as a write. Partial because a transition sets only what it
 * changes: STOPPING keeps the process columns it inherited, and RUNNING sets
 * `pid`/`port` only when the spawn reported them.
 */
export type RunScriptExecutionUpdate = Partial<RunScriptExecutionFields>;

/** The three cached `factory-factory.json` commands. */
export type RunScriptCommandFields = Pick<
  WorkspaceRunScriptFields,
  'runScriptCommand' | 'runScriptPostRunCommand' | 'runScriptCleanupCommand'
>;

/**
 * Translate caller-facing `runScript*` names to column names, dropping keys the
 * caller left absent so a partial write stays partial. `undefined` means "not
 * supplied"; `null` is a value and is written.
 */
function toColumns(fields: WorkspaceRunScriptWriteFields): Prisma.WorkspaceRunScriptUpdateInput {
  const columns: Prisma.WorkspaceRunScriptUpdateInput = {};
  if (fields.runScriptCommand !== undefined) {
    columns.command = fields.runScriptCommand;
  }
  if (fields.runScriptPostRunCommand !== undefined) {
    columns.postRunCommand = fields.runScriptPostRunCommand;
  }
  if (fields.runScriptCleanupCommand !== undefined) {
    columns.cleanupCommand = fields.runScriptCleanupCommand;
  }
  if (fields.runScriptPid !== undefined) {
    columns.pid = fields.runScriptPid;
  }
  if (fields.runScriptPort !== undefined) {
    columns.port = fields.runScriptPort;
  }
  if (fields.runScriptStartedAt !== undefined) {
    columns.startedAt = fields.runScriptStartedAt;
  }
  if (fields.runScriptStatus !== undefined) {
    columns.status = fields.runScriptStatus;
  }
  return columns;
}

/**
 * The transient statuses a restart invalidates: both describe a transition that
 * only the process performing it could finish.
 */
const TRANSIENT_STATUSES = ['STARTING', 'STOPPING'] as const satisfies RunScriptStatus[];

const EXECUTION_SELECT = { status: true, pid: true, port: true, startedAt: true } as const;

type ExecutionRow = {
  status: RunScriptStatus;
  pid: number | null;
  port: number | null;
  startedAt: Date | null;
};

function toExecutionFields(row: ExecutionRow): RunScriptExecutionFields {
  return {
    runScriptStatus: row.status,
    runScriptPid: row.pid,
    runScriptPort: row.port,
    runScriptStartedAt: row.startedAt,
  };
}

class WorkspaceRunScriptAccessor {
  /** Read the four process columns, or null if the workspace does not exist. */
  async findExecutionState(workspaceId: string): Promise<RunScriptExecutionFields | null> {
    const row = await prisma.workspaceRunScript.findUnique({
      where: { workspaceId },
      select: EXECUTION_SELECT,
    });
    return row ? toExecutionFields(row) : null;
  }

  /**
   * As `findExecutionState`, but for the read a state machine does after a
   * successful compare-and-swap, where a missing row is a bug rather than a
   * caller-visible outcome.
   */
  async findExecutionStateOrThrow(workspaceId: string): Promise<RunScriptExecutionFields> {
    const row = await prisma.workspaceRunScript.findUniqueOrThrow({
      where: { workspaceId },
      select: EXECUTION_SELECT,
    });
    return toExecutionFields(row);
  }

  /**
   * Write the supplied subset of the cached commands.
   *
   * Runs in the caller's transaction when one is given: registering a freshly
   * initialized worktree writes the worktree path on `Workspace` and the commands
   * read out of its `factory-factory.json` here, and those two used to be one
   * statement.
   */
  async writeCommands(
    workspaceId: string,
    fields: RunScriptCommandFields,
    transaction?: Prisma.TransactionClient
  ): Promise<void> {
    const client = transaction ?? prisma;
    const result = await client.workspaceRunScript.updateMany({
      where: { workspaceId },
      data: toColumns(fields),
    });
    // A row exists for every workspace, so a miss means the workspace was deleted
    // between the config being read and persisted. The pre-split write raised on
    // that too, by way of `prisma.workspace.update`.
    if (result.count === 0) {
      throw new Error(`WorkspaceRunScript row not found for workspace: ${workspaceId}`);
    }
  }

  /**
   * Compare-and-swap the process columns on the status they were decided from.
   * Returns the affected count so callers can tell a lost race from a win, which
   * is how the run-script state machine detects a concurrent start or stop.
   */
  casExecutionUpdate(
    workspaceId: string,
    currentStatus: RunScriptStatus,
    fields: RunScriptExecutionUpdate
  ): Promise<{ count: number }> {
    return prisma.workspaceRunScript.updateMany({
      where: { workspaceId, status: currentStatus },
      data: toColumns(fields),
    });
  }

  /**
   * Reset workspaces left in a transient run-script status to IDLE, clearing the
   * process columns with it. Called at server startup: STARTING and STOPPING
   * describe a transition in flight, and the process that was performing it is
   * gone.
   *
   * Returns the affected workspaces and their prior status so the caller can emit
   * the status-changed events the snapshot stream needs.
   */
  async resetStaleTransientStatuses(): Promise<
    Array<{ id: string; runScriptStatus: RunScriptStatus }>
  > {
    const stale = await prisma.workspaceRunScript.findMany({
      where: { status: { in: TRANSIENT_STATUSES } },
      select: { workspaceId: true, status: true },
    });

    if (stale.length === 0) {
      return [];
    }

    await prisma.workspaceRunScript.updateMany({
      where: {
        workspaceId: { in: stale.map((row) => row.workspaceId) },
        status: { in: TRANSIENT_STATUSES },
      },
      data: { status: 'IDLE', pid: null, port: null, startedAt: null },
    });

    return stale.map((row) => ({ id: row.workspaceId, runScriptStatus: row.status }));
  }
}

export const workspaceRunScriptAccessor = new WorkspaceRunScriptAccessor();
