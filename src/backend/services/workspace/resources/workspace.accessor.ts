import { isDeepStrictEqual } from 'node:util';
import { prisma } from '@/backend/db';
import { ApplicationError } from '@/backend/lib/application-error';
import {
  projectWorkspacePRCollection,
  type WorkspacePRRow,
  workspacePrAccessor,
} from '@/backend/services/workspace/resources/workspace-pr.accessor';
import {
  flattenWorkspaceRatchet,
  type WorkspaceRatchetFields,
  type WorkspaceRatchetRow,
} from '@/backend/services/workspace/resources/workspace-ratchet.accessor';
import {
  flattenWorkspaceRunScript,
  type RunScriptCommandFields,
  type RunScriptExecutionFields,
  type RunScriptExecutionUpdate,
  type WorkspaceRunScriptFields,
  type WorkspaceRunScriptRow,
  workspaceRunScriptAccessor,
} from '@/backend/services/workspace/resources/workspace-run-script.accessor';
import type {
  WorkspaceFixerContext,
  WorkspacePRContext,
  WorkspaceProviderSelectionSnapshot,
  WorkspaceStatusSnapshot,
  WorkspaceDeletionCapture,
} from '@/backend/services/workspace/types';
import type { RatchetState, RunScriptStatus, WorkspaceStatus } from '@/shared/core';
import {
  eventWorkspaceIdentitySchema,
  eventLaunchIdentifierSchema,
  type EventWorkspaceIdentity,
} from '@/shared/event-agent-launch';
import type { WorkspaceInitGuard } from '@/shared/workspace-init-retry';
import { selectWorkspacePR } from '@/shared/workspace-pr';
import { Prisma, type Workspace, type WorkspacePRDiscovery } from '@prisma-gen/client';
import { workspaceChildOriginAccessor } from './workspace-child-origin.accessor';
import { deleteWorkspace } from './workspace-delete.accessor';
import {
  projectWorkspaceFamily,
  workspaceFamilyInclude,
  type WorkspaceFamilyFields,
} from './workspace-family-projection';
import { withWorkspaceInitGuard } from './workspace-init-guard';
import type { CreateWorkspaceInput, UpdateWorkspaceInput } from './workspace-inputs';
import { workspaceLaunchOriginAccessor } from './workspace-launch-origin.accessor';
import { projectConversationSummary } from './workspace-metadata.accessor';
import { flattenPRDiscovery } from './workspace-pr-discovery.accessor';

/** Run-script process fields projected under their existing flat names. */
export type RunScriptExecutionState = RunScriptExecutionFields;

/**
 * Threshold for considering a PROVISIONING workspace as stale.
 * Workspaces in PROVISIONING state for longer than this are considered
 * stuck (e.g., due to server crash) and will be recovered by reconciliation.
 */
const STALE_PROVISIONING_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Threshold for considering an ARCHIVING workspace as stale.
 * ARCHIVING is a persisted transient state; after this threshold, no
 * in-flight archive from the current process should still be active.
 */
const STALE_ARCHIVING_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

interface FindByProjectIdFilters {
  excludeStatuses?: WorkspaceStatus[];
}

/** Flatten side-table inputs at the read boundary; Ratchet state is derived, never stored. */
type Flattened<T> = Omit<
  T,
  | 'prMonitoring'
  | 'prs'
  | 'prDiscovery'
  | 'runScript'
  | '_count'
  | 'conversationMetadata'
  | 'parentWorkspace'
> &
  WorkspaceFamilyFields &
  WorkspaceRatchetFields &
  ReturnType<typeof projectWorkspacePRCollection> &
  WorkspaceRunScriptFields & {
    ratchetState: RatchetState;
    conversationSummary: ReturnType<typeof projectConversationSummary>;
  };

function flatten<
  T extends {
    prMonitoring?: WorkspaceRatchetRow | null;
    prs?: WorkspacePRRow[];
    prDiscovery?: WorkspacePRDiscovery | null;
    runScript?: WorkspaceRunScriptRow | null;
    _count?: { prEvents: number; childWorkspaces?: number };
    parentWorkspace?: Parameters<typeof projectWorkspaceFamily>[0]['parentWorkspace'];
    conversationMetadata?: Parameters<typeof projectConversationSummary>[0];
  },
>(row: T): Flattened<T> {
  const {
    prMonitoring,
    prs = [],
    prDiscovery,
    runScript,
    _count,
    conversationMetadata,
    parentWorkspace,
    ...rest
  } = row;
  const ratchetFields = flattenWorkspaceRatchet(prMonitoring, _count?.prEvents ?? 0);
  return {
    ...rest,
    ...projectWorkspaceFamily({ parentWorkspace, _count }),
    conversationSummary: projectConversationSummary(conversationMetadata),
    ...ratchetFields,
    ...projectWorkspacePRCollection(prs, ratchetFields.ratchetEnabled, true),
    ...flattenPRDiscovery(prDiscovery),
    ...flattenWorkspaceRunScript(runScript),
  };
}

/** Included on every read that has to reproduce the old flat workspace shape. */
const sideTables = {
  conversationMetadata: true,
  prMonitoring: true,
  prs: { orderBy: { id: 'asc' } },
  prDiscovery: true,
  runScript: true,
  ...workspaceFamilyInclude,
} satisfies Prisma.WorkspaceInclude;

type SideTableInclude = typeof sideTables;

/** Side-table reads and flattening for sibling accessors that project their own workspace shape. */
export {
  flatten as flattenWorkspaceRow,
  sideTables as workspaceSideTables,
  type Flattened as FlattenedWorkspaceRow,
  type SideTableInclude as WorkspaceSideTableInclude,
};

/** A bare workspace row with its side-table fields flattened on. */
export type WorkspaceWithRatchet = Flattened<
  Prisma.WorkspaceGetPayload<{ include: SideTableInclude }>
>;

type WorkspaceWithAgentSessions = Flattened<
  Prisma.WorkspaceGetPayload<{
    include: { agentSessions: true; terminalSessions: true } & SideTableInclude;
  }>
>;

export type WorkspaceWithSessions = WorkspaceWithAgentSessions;

/**
 * Workspace with project included, PR cache flattened on.
 *
 * The PR fields are here because callers of these finders read them — archive
 * decides whether to comment on the linked issue from `prState`/`prUrl`. The
 * ratchet fields are not, because none of them do.
 */
const projectAndPR = {
  project: true,
  prMonitoring: { select: { enabled: true } },
  prs: { orderBy: { id: 'asc' } },
  prDiscovery: true,
} satisfies Prisma.WorkspaceInclude;
type WorkspaceWithProjectInclude = typeof projectAndPR;

type WorkspaceWithProject = Omit<
  Prisma.WorkspaceGetPayload<{ include: WorkspaceWithProjectInclude }>,
  'prs' | 'prDiscovery' | 'prMonitoring'
> &
  Omit<ReturnType<typeof projectWorkspacePRCollection>, 'ratchetState'>;

function withProjectAndPR(
  row: Prisma.WorkspaceGetPayload<{ include: WorkspaceWithProjectInclude }>
): WorkspaceWithProject {
  const { prs = [], prDiscovery, prMonitoring, ...rest } = row;
  // Project metadata reads expose PR facts without the full ratchet fields.
  const { ratchetState: _ratchetState, ...prFields } = projectWorkspacePRCollection(
    prs,
    prMonitoring?.enabled ?? false,
    true
  );
  return {
    ...rest,
    ...prFields,
    ...flattenPRDiscovery(prDiscovery),
  };
}

type WorkspaceWithAgentSessionsAndProject = Flattened<
  Prisma.WorkspaceGetPayload<{
    include: {
      agentSessions: true;
      terminalSessions: true;
      project: true;
    } & SideTableInclude;
  }>
>;

// Type for Workspace with sessions and project included (used by reconciliation)
export type WorkspaceWithSessionsAndProject = WorkspaceWithAgentSessionsAndProject;

class WorkspaceAccessor {
  async restorePeriodicTaskLinks(
    tx: Prisma.TransactionClient,
    sourceRows: readonly { id: string; periodicTaskId: string; updatedAt: string }[],
    createdWorkspaceIds: ReadonlySet<string>,
    createdTaskIds: ReadonlySet<string>
  ) {
    let imported = 0;
    for (const row of sourceRows) {
      if (!(createdWorkspaceIds.has(row.id) && createdTaskIds.has(row.periodicTaskId))) {
        continue;
      }
      await tx.workspace.update({
        where: { id: row.id },
        data: { periodicTaskId: row.periodicTaskId, updatedAt: new Date(row.updatedAt) },
      });
      imported++;
    }
    const skipped = sourceRows.length - imported;
    return {
      model: 'Workspace' as const,
      imported,
      skipped,
      reasons: { INCOMPLETE_DEPENDENCY: skipped },
    };
  }

  create(data: CreateWorkspaceInput): Promise<WorkspaceWithRatchet> {
    return data.parentWorkspaceId
      ? prisma.$transaction((transaction) => this.insertWorkspace(data, transaction))
      : this.insertWorkspace(data, prisma);
  }

  private async insertWorkspace(
    data: CreateWorkspaceInput & { id?: string },
    transaction: Prisma.TransactionClient
  ) {
    const created = await transaction.workspace.create({
      data: {
        id: data.id,
        // Keep the active-project condition in the nested write transaction.
        project: { connect: { id: data.projectId, isArchived: false } },
        parentWorkspace: data.parentWorkspaceId
          ? { connect: { id: data.parentWorkspaceId } }
          : undefined,
        periodicTask: data.periodicTaskId ? { connect: { id: data.periodicTaskId } } : undefined,
        name: data.name,
        description: data.description,
        branchName: data.branchName,
        githubIssueNumber: data.githubIssueNumber,
        githubIssueUrl: data.githubIssueUrl,
        linearIssueId: data.linearIssueId,
        linearIssueIdentifier: data.linearIssueIdentifier,
        linearIssueUrl: data.linearIssueUrl,
        isAutoGeneratedBranch: data.isAutoGeneratedBranch ?? false,
        // Create side-table rows before guarded PR discovery and run-script writes.
        prMonitoring: {
          create: {
            enabled: data.ratchetEnabled ?? false,
            eventEpoch: data.ratchetEnabled ? 1 : 0,
          },
        },
        prDiscovery: { create: {} },
        runScript: { create: {} },
        defaultSessionProvider: data.defaultSessionProvider,

        creationSource: data.creationSource,
        creationMetadata: data.creationMetadata,
      },
      include: sideTables,
    });
    await workspaceChildOriginAccessor.retain(transaction, created);
    return flatten(created);
  }

  async createEventOnce(
    data: CreateWorkspaceInput & {
      id: string;
      runId: string;
      creationMetadata: EventWorkspaceIdentity;
    }
  ) {
    eventLaunchIdentifierSchema.parse(data.id);
    eventLaunchIdentifierSchema.parse(data.runId);
    eventLaunchIdentifierSchema.parse(data.projectId);
    const metadata = eventWorkspaceIdentitySchema.safeParse(data.creationMetadata);
    if (!metadata.success || metadata.data.runId !== data.runId) {
      throw new ApplicationError('INVALID_INPUT', 'Event workspace creation metadata is invalid');
    }
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "Workspace" SET "id" = "id" WHERE 0`;
      const identity = { runId: data.runId, workspaceId: data.id, projectId: data.projectId };
      const origin = await workspaceLaunchOriginAccessor.find(tx, identity);
      if (origin) {
        if (
          origin.runId !== data.runId ||
          origin.workspaceId !== data.id ||
          origin.projectId !== data.projectId
        ) {
          throw new ApplicationError('CONFLICT', 'Event workspace ownership mismatch');
        }
        return { workspace: await this.reuseEventWorkspace(tx, data), created: false };
      }
      const workspace = await this.insertWorkspace(
        {
          ...data,
          creationMetadata: metadata.data,
          creationSource: 'EVENT_AGENT',
          ratchetEnabled: false,
        },
        tx
      ).catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
          throw new ApplicationError(
            'PRECONDITION_FAILED',
            'Event workspace project is missing or archived'
          );
        }
        throw error;
      });
      await workspaceLaunchOriginAccessor.create(tx, identity);
      return { workspace, created: true };
    });
  }

  private async reuseEventWorkspace(
    transaction: Prisma.TransactionClient,
    data: CreateWorkspaceInput & { id: string; runId: string }
  ) {
    const existing = await transaction.workspace.findUnique({
      where: { id: data.id },
      include: { ...sideTables, project: true },
    });
    if (!existing) {
      throw new ApplicationError('PRECONDITION_FAILED', 'Event workspace was deleted');
    }
    if (
      existing.status === 'ARCHIVING' ||
      existing.status === 'ARCHIVED' ||
      existing.project.isArchived
    ) {
      throw new ApplicationError('PRECONDITION_FAILED', 'Event workspace or project is archived');
    }
    if (existing.projectId !== data.projectId || existing.creationSource !== 'EVENT_AGENT') {
      throw new ApplicationError('CONFLICT', 'Event workspace ownership mismatch');
    }
    const originalIdentity = eventWorkspaceIdentitySchema.parse(existing.creationMetadata);
    if (
      !isDeepStrictEqual(
        originalIdentity,
        eventWorkspaceIdentitySchema.parse(data.creationMetadata)
      )
    ) {
      throw new ApplicationError(
        'CONFLICT',
        'Event workspace reserved identity ownership mismatch'
      );
    }
    return flatten(existing);
  }

  async findById(id: string): Promise<WorkspaceWithSessions | null> {
    const row = await prisma.workspace.findUnique({
      where: { id },
      include: {
        agentSessions: true,
        terminalSessions: true,
        ...sideTables,
      },
    });
    return row ? flatten(row) : null;
  }

  /**
   * Find a workspace without relation includes.
   * Used by state machines that only need the raw row.
   */
  findRawById(id: string): Promise<Workspace | null> {
    return prisma.workspace.findUnique({
      where: { id },
    });
  }

  async exists(id: string): Promise<boolean> {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      select: { id: true },
    });
    return workspace !== null;
  }

  findProviderSelection(id: string): Promise<WorkspaceProviderSelectionSnapshot | null> {
    return prisma.workspace.findUnique({
      where: { id },
      select: {
        id: true,
        defaultSessionProvider: true,
      },
    });
  }

  findFixerContext(id: string): Promise<WorkspaceFixerContext | null> {
    return prisma.workspace.findUnique({
      where: { id },
      select: {
        id: true,
        worktreePath: true,
        defaultSessionProvider: true,
      },
    });
  }

  async findStatusSnapshot(id: string): Promise<WorkspaceStatusSnapshot | null> {
    const row = await prisma.workspace.findUnique({
      where: { id },
      select: {
        status: true,
        initCompletedAt: true,
        prs: {
          where: { detachedAt: null },
          orderBy: { id: 'asc' },
          select: { id: true, url: true, number: true, state: true },
        },
      },
    });
    if (!row) {
      return null;
    }
    const selectedPr = selectWorkspacePR(row.prs);
    return {
      status: row.status,
      initCompletedAt: row.initCompletedAt,
      prUrl: selectedPr?.url ?? null,
      prNumber: selectedPr?.number ?? null,
    };
  }

  async findPRContext(id: string): Promise<WorkspacePRContext | null> {
    const row = await prisma.workspace.findUnique({
      where: { id },
      select: {
        branchName: true,
        prs: {
          where: { detachedAt: null },
          orderBy: { id: 'asc' },
          select: { id: true, url: true, state: true },
        },
      },
    });
    return row
      ? { branchName: row.branchName, prUrl: selectWorkspacePR(row.prs)?.url ?? null }
      : null;
  }

  /**
   * Find a workspace without relation includes and throw if missing.
   * Used by state machines after compare-and-swap updates.
   */
  findRawByIdOrThrow(id: string): Promise<Workspace> {
    return prisma.workspace.findUniqueOrThrow({
      where: { id },
    });
  }

  findRunScriptExecutionState(id: string): Promise<RunScriptExecutionState | null> {
    return workspaceRunScriptAccessor.findExecutionState(id);
  }

  findRunScriptExecutionStateOrThrow(id: string): Promise<RunScriptExecutionState> {
    return workspaceRunScriptAccessor.findExecutionStateOrThrow(id);
  }

  findByProjectId(projectId: string): Promise<Workspace[]> {
    return prisma.workspace.findMany({
      where: { projectId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Issue links for a project's live workspaces. Selects only the columns issue
   * filtering needs and skips archived rows: whole rows carry large init
   * output/metadata blobs, and archived rows dominate long-lived projects.
   */
  findIssueLinksByProjectId(
    projectId: string
  ): Promise<Pick<Workspace, 'status' | 'githubIssueNumber' | 'linearIssueId'>[]> {
    return prisma.workspace.findMany({
      where: {
        projectId,
        status: { notIn: ['ARCHIVING', 'ARCHIVED'] },
      },
      select: { status: true, githubIssueNumber: true, linearIssueId: true },
    });
  }

  /** Find workspaces with sessions included, for derived-state computation. */
  async findByProjectIdWithSessions(
    projectId: string,
    filters?: FindByProjectIdFilters
  ): Promise<WorkspaceWithSessions[]> {
    const where: Prisma.WorkspaceWhereInput = { projectId };

    if (filters?.excludeStatuses && filters.excludeStatuses.length > 0) {
      where.status = { notIn: filters.excludeStatuses };
    }

    const rows = await prisma.workspace.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        agentSessions: true,
        terminalSessions: true,
        ...sideTables,
      },
    });
    return rows.map(flatten);
  }

  /**
   * Find all non-archived workspaces with sessions and project included.
   * Used by the reconciliation service for single-query fetch of all workspace data.
   */
  async findAllNonArchivedWithSessionsAndProject(): Promise<WorkspaceWithSessionsAndProject[]> {
    const rows = await prisma.workspace.findMany({
      where: { status: { not: 'ARCHIVED' } },
      include: {
        agentSessions: true,
        terminalSessions: true,
        project: true,
        ...sideTables,
      },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(flatten);
  }

  /** Find the IDs and worktree paths of every workspace that still owns its worktree. */
  findNonArchivedWorktreeRefs(): Promise<Array<{ id: string; worktreePath: string | null }>> {
    return prisma.workspace.findMany({
      where: { status: { not: 'ARCHIVED' } },
      select: { id: true, worktreePath: true },
    });
  }

  async detachPR(target: { workspaceId: string; prId: string }) {
    return { removed: await workspacePrAccessor.detach(target), dispatchReleased: false };
  }

  update(id: string, data: UpdateWorkspaceInput): Promise<Workspace> {
    return prisma.workspace.update({
      where: { id },
      data,
    });
  }

  /**
   * Atomic compare-and-swap transition for workspace status.
   * Returns count=1 only when current status matches fromStatus.
   * Used to prevent race conditions in state transitions.
   */
  transitionWithCas(
    id: string,
    fromStatus: WorkspaceStatus,
    data: Prisma.WorkspaceUpdateManyMutationInput,
    guard?: WorkspaceInitGuard
  ): Promise<{ count: number }> {
    return withWorkspaceInitGuard(id, guard, (transaction) =>
      transaction.workspace.updateMany({
        where: { id, status: fromStatus },
        data,
      })
    );
  }

  /**
   * Compare-and-swap update for run script status transitions.
   * Returns count=1 only when current status matches.
   */
  casRunScriptStatusUpdate(
    id: string,
    currentStatus: RunScriptStatus,
    data: RunScriptExecutionUpdate
  ): Promise<{ count: number }> {
    return workspaceRunScriptAccessor.casExecutionUpdate(id, currentStatus, data);
  }

  /**
   * Write the cached `factory-factory.json` commands alongside the worktree the
   * config was read from.
   *
   * The worktree columns are the workspace's own and the commands are the
   * run-script row's, so this is the transaction that keeps a freshly initialized
   * worktree from being observable without the commands it declared — one
   * statement before the split.
   */
  async registerInitializedWorktree(
    id: string,
    worktree: { worktreePath: string; branchName: string | null; isAutoGeneratedBranch: boolean },
    commands: RunScriptCommandFields,
    guard?: WorkspaceInitGuard
  ): Promise<void> {
    const write = async (transaction: Prisma.TransactionClient) => {
      await transaction.workspace.update({ where: { id }, data: worktree });
      await workspaceRunScriptAccessor.writeCommands(id, commands, transaction);
    };
    if (guard) {
      await withWorkspaceInitGuard(id, guard, write);
    } else {
      await prisma.$transaction(write);
    }
  }

  /** Refresh the cached commands from the worktree's `factory-factory.json`. */
  setRunScriptCommands(
    id: string,
    commands: RunScriptCommandFields,
    guard?: WorkspaceInitGuard
  ): Promise<void> {
    return withWorkspaceInitGuard(id, guard, (transaction) =>
      workspaceRunScriptAccessor.writeCommands(id, commands, transaction)
    );
  }

  /**
   * Find workspaces with transient run script statuses (STARTING or STOPPING)
   * and reset them to IDLE. Called at server startup to recover states left
   * in-flight by a server crash or restart.
   * Returns the affected workspaces (id + prior status) for logging/event emission.
   */
  resetStaleRunScriptStatuses(): Promise<Array<{ id: string; runScriptStatus: RunScriptStatus }>> {
    return workspaceRunScriptAccessor.resetStaleTransientStatuses();
  }

  /**
   * Conditional provisioning retry transition (FAILED -> PROVISIONING).
   * Returns count=1 when retry is allowed and transition was applied.
   */
  startProvisioningRetryIfAllowed(
    id: string,
    maxRetries: number,
    guard?: WorkspaceInitGuard
  ): Promise<{ count: number }> {
    return withWorkspaceInitGuard(id, guard, (transaction) =>
      transaction.workspace.updateMany({
        where: {
          id,
          status: 'FAILED',
          initRetryCount: { lt: maxRetries },
        },
        data: {
          status: 'PROVISIONING',
          initRetryCount: { increment: 1 },
          initStartedAt: new Date(),
          initErrorMessage: null,
          initScriptPid: null,
        },
      })
    );
  }

  /**
   * Conditional provisioning retry transition (READY -> PROVISIONING).
   * Used when a workspace is READY+warning and the user retries the setup script.
   * Returns count=1 when retry is allowed and transition was applied.
   */
  startProvisioningFromReadyIfAllowed(
    id: string,
    maxRetries: number,
    guard?: WorkspaceInitGuard
  ): Promise<{ count: number }> {
    return withWorkspaceInitGuard(id, guard, (transaction) =>
      transaction.workspace.updateMany({
        where: {
          id,
          status: 'READY',
          initRetryCount: { lt: maxRetries },
        },
        data: {
          status: 'PROVISIONING',
          initRetryCount: { increment: 1 },
          initStartedAt: new Date(),
          initErrorMessage: null,
          initScriptPid: null,
        },
      })
    );
  }

  /**
   * Conditional reset transition (FAILED -> NEW).
   * Returns count=1 when retry is allowed and transition was applied.
   */
  resetToNewIfAllowed(
    id: string,
    maxRetries: number,
    guard?: WorkspaceInitGuard
  ): Promise<{ count: number }> {
    return withWorkspaceInitGuard(id, guard, (transaction) =>
      transaction.workspace.updateMany({
        where: {
          id,
          status: 'FAILED',
          initRetryCount: { lt: maxRetries },
        },
        data: {
          status: 'NEW',
          initRetryCount: { increment: 1 },
          initStartedAt: null,
          initCompletedAt: null,
          initErrorMessage: null,
          initScriptPid: null,
        },
      })
    );
  }

  delete(id: string, capture: WorkspaceDeletionCapture): Promise<Workspace> {
    return deleteWorkspace(id, capture);
  }

  // Note: archive functionality is provided by workspaceStateMachine.markArchived()

  /**
   * Find workspaces that need worktree creation or recovery.
   * Returns:
   * - NEW workspaces that haven't started provisioning yet
   * - PROVISIONING workspaces that are stale (>10 minutes) and likely stuck due to server crash
   *
   * Used for reconciliation to ensure all workspaces are initialized.
   * Includes project for worktree creation.
   */
  async findNeedingWorktree(): Promise<WorkspaceWithProject[]> {
    const staleThreshold = new Date(Date.now() - STALE_PROVISIONING_THRESHOLD_MS);

    const rows = await prisma.workspace.findMany({
      where: {
        OR: [
          { status: 'NEW' },
          {
            status: 'PROVISIONING',
            initStartedAt: { lt: staleThreshold },
          },
        ],
      },
      include: projectAndPR,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(withProjectAndPR);
  }

  /**
   * Find ARCHIVING workspaces that have been stuck long enough to recover.
   * Includes project data so the archive workflow can safely clean up worktrees.
   */
  async findStaleArchivingWithProject(): Promise<WorkspaceWithProject[]> {
    const staleThreshold = new Date(Date.now() - STALE_ARCHIVING_THRESHOLD_MS);

    const rows = await prisma.workspace.findMany({
      where: {
        status: 'ARCHIVING',
        updatedAt: { lt: staleThreshold },
      },
      include: projectAndPR,
      orderBy: { updatedAt: 'asc' },
    });
    return rows.map(withProjectAndPR);
  }

  /**
   * Find workspace by ID with project included.
   * Used when project info is needed (e.g., for worktree creation).
   */
  async findByIdWithProject(id: string): Promise<WorkspaceWithProject | null> {
    const row = await prisma.workspace.findUnique({
      where: { id },
      include: projectAndPR,
    });
    return row ? withProjectAndPR(row) : null;
  }

  /**
   * PR sync and PR discovery candidates moved to `workspacePrAccessor`
   * (`findNeedingSync` / `findNeedingDiscovery`) along with the columns they
   * filter and order on.
   */

  /**
   * Mark workspace as having had sessions (for kanban backlog/waiting distinction).
   * Uses atomic conditional update to prevent race conditions when multiple sessions start.
   */
  async markHasHadSessions(id: string): Promise<void> {
    await prisma.workspace.updateMany({
      where: { id, hasHadSessions: false },
      data: { hasHadSessions: true },
    });
  }

  /**
   * Rename the branch and clear the PR discovery schedule together, so discovery
   * re-checks the new branch immediately instead of waiting out a backoff earned
   * by the old one.
   */
  setBranchNameAndClearDiscoverySchedule(workspaceId: string, branchName: string) {
    return prisma.$transaction(async (transaction) => {
      const accepted = await transaction.workspace.update({
        where: { id: workspaceId },
        data: { branchName, isAutoGeneratedBranch: false },
        select: { id: true, branchName: true, updatedAt: true, status: true },
      });
      await workspacePrAccessor.clearDiscoverySchedule(transaction, workspaceId);
      return accepted;
    });
  }

  /**
   * Append output to initOutput field during startup script execution.
   * Truncates from the beginning if output exceeds maxSize to prevent unbounded growth.
   */
  async appendInitOutput(
    id: string,
    output: string,
    maxSize = 50 * 1024,
    guard?: WorkspaceInitGuard
  ): Promise<void> {
    await withWorkspaceInitGuard(id, guard, async (transaction) => {
      const truncationMarker = '[...truncated...]\n';
      const markerLength = truncationMarker.length;
      const now = new Date();
      const updatedRows = await transaction.$executeRaw`
      UPDATE "Workspace"
      SET "initOutput" = CASE
        WHEN length(COALESCE("initOutput", '') || ${output}) <= ${maxSize}
          THEN COALESCE("initOutput", '') || ${output}
        WHEN ${maxSize} <= ${markerLength}
          THEN substr(${truncationMarker}, 1, ${maxSize})
        ELSE ${truncationMarker} || substr(
          COALESCE("initOutput", '') || ${output},
          -(${maxSize} - ${markerLength})
        )
      END,
      "updatedAt" = ${now}
      WHERE "id" = ${id}
    `;

      if (Number(updatedRows) === 0) {
        const existing = await transaction.workspace.findUnique({
          where: { id },
          select: { id: true },
        });
        if (!existing) {
          throw new Error(`Workspace not found: ${id}`);
        }
      }
    });
  }

  /**
   * Track the currently running startup/setup script process for provisioning recovery.
   */
  async setInitScriptPid(id: string, pid: number, guard?: WorkspaceInitGuard): Promise<void> {
    await withWorkspaceInitGuard(id, guard, async (transaction) => {
      await transaction.workspace.updateMany({
        where: { id, status: 'PROVISIONING' },
        data: { initScriptPid: pid },
      });
    });
  }

  /**
   * Clear startup/setup script process tracking if it still points to the given process.
   */
  async clearInitScriptPid(id: string, pid: number, guard?: WorkspaceInitGuard): Promise<void> {
    await withWorkspaceInitGuard(id, guard, async (transaction) => {
      await transaction.workspace.updateMany({
        where: { id, initScriptPid: pid },
        data: { initScriptPid: null },
      });
    });
  }

  /**
   * Clear initOutput field (called when retrying initialization).
   */
  async clearInitOutput(id: string, guard?: WorkspaceInitGuard): Promise<void> {
    await withWorkspaceInitGuard(id, guard, async (transaction) => {
      await transaction.workspace.update({
        where: { id },
        data: { initOutput: null },
      });
    });
  }

  /**
   * Find multiple workspaces by their IDs with project included.
   * Used for batch lookups when project info is needed (e.g., admin process list).
   */
  async findByIdsWithProject(ids: string[]): Promise<WorkspaceWithProject[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await prisma.workspace.findMany({
      where: {
        id: { in: ids },
      },
      include: projectAndPR,
    });
    return rows.map(withProjectAndPR);
  }

  // ---------------------------------------------------------------------------
  // Parent / child workspace hierarchy
  // ---------------------------------------------------------------------------

  /**
   * Find non-archived child workspaces for a given parent.
   */
  findChildrenByParentId(parentId: string): Promise<Workspace[]> {
    return prisma.workspace.findMany({
      where: { parentWorkspaceId: parentId, status: { not: 'ARCHIVED' } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Find child workspaces with session counts included, for status summaries.
   */
  async findChildrenWithStatus(parentId: string): Promise<
    Flattened<
      Prisma.WorkspaceGetPayload<{
        include: { agentSessions: true; project: true } & SideTableInclude;
      }>
    >[]
  > {
    const rows = await prisma.workspace.findMany({
      where: { parentWorkspaceId: parentId, status: { not: 'ARCHIVED' } },
      include: { agentSessions: true, project: true, ...sideTables },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(flatten);
  }

  /**
   * Find the parent workspace summary for a given child workspace id.
   * Returns the parent with project included for cross-project navigation.
   */
  async findParentWorkspace(childId: string): Promise<WorkspaceWithProject | null> {
    const row = await prisma.workspace.findFirst({
      where: { childWorkspaces: { some: { id: childId } } },
      include: projectAndPR,
    });
    return row ? withProjectAndPR(row) : null;
  }
}

export const workspaceAccessor = new WorkspaceAccessor();
