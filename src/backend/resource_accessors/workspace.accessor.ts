import type {
  CIStatus,
  KanbanColumn,
  PRState,
  Prisma,
  SessionStatus,
  Workspace,
  WorkspaceStatus,
} from '@prisma-gen/client';
import { prisma } from '../db';

/**
 * Threshold for considering a PROVISIONING workspace as stale.
 * Workspaces in PROVISIONING state for longer than this are considered
 * stuck (e.g., due to server crash) and will be recovered by reconciliation.
 */
const STALE_PROVISIONING_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

interface CreateWorkspaceInput {
  projectId: string;
  name: string;
  description?: string;
  branchName?: string;
}

interface UpdateWorkspaceInput {
  name?: string;
  description?: string;
  // Note: status changes must go through workspaceStateMachine, not direct updates
  worktreePath?: string | null;
  branchName?: string | null;
  prUrl?: string | null;
  githubIssueNumber?: number | null;
  githubIssueUrl?: string | null;
  // PR tracking fields
  prNumber?: number | null;
  prState?: PRState;
  prReviewState?: string | null;
  prCiStatus?: CIStatus;
  prUpdatedAt?: Date | null;
  // CI failure tracking
  prCiFailedAt?: Date | null;
  prCiLastNotifiedAt?: Date | null;
  // Activity tracking
  hasHadSessions?: boolean;
  // Cached kanban column
  cachedKanbanColumn?: KanbanColumn;
  stateComputedAt?: Date | null;
  // Run script tracking
  runScriptCommand?: string | null;
  runScriptCleanupCommand?: string | null;
  runScriptPid?: number | null;
  runScriptPort?: number | null;
  runScriptStartedAt?: Date | null;
  runScriptStatus?: SessionStatus;
}

interface FindByProjectIdFilters {
  status?: WorkspaceStatus;
  excludeStatuses?: WorkspaceStatus[];
  kanbanColumn?: KanbanColumn;
  limit?: number;
  offset?: number;
}

// Type for Workspace with sessions included
type WorkspaceWithSessions = Prisma.WorkspaceGetPayload<{
  include: { claudeSessions: true; terminalSessions: true };
}>;

// Type for Workspace with project included
type WorkspaceWithProject = Prisma.WorkspaceGetPayload<{
  include: { project: true };
}>;

class WorkspaceAccessor {
  create(data: CreateWorkspaceInput): Promise<Workspace> {
    return prisma.workspace.create({
      data: {
        projectId: data.projectId,
        name: data.name,
        description: data.description,
        branchName: data.branchName,
      },
    });
  }

  findById(id: string): Promise<WorkspaceWithSessions | null> {
    return prisma.workspace.findUnique({
      where: { id },
      include: {
        claudeSessions: true,
        terminalSessions: true,
      },
    });
  }

  findByProjectId(projectId: string, filters?: FindByProjectIdFilters): Promise<Workspace[]> {
    const where: Prisma.WorkspaceWhereInput = { projectId };

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.kanbanColumn) {
      where.cachedKanbanColumn = filters.kanbanColumn;
    }

    return prisma.workspace.findMany({
      where,
      take: filters?.limit,
      skip: filters?.offset,
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Find workspaces with sessions included (for kanban state computation).
   *
   * @throws Error if both status and excludeStatuses filters are specified
   */
  findByProjectIdWithSessions(
    projectId: string,
    filters?: FindByProjectIdFilters
  ): Promise<WorkspaceWithSessions[]> {
    // Validate mutually exclusive filters
    if (filters?.status && filters?.excludeStatuses?.length) {
      throw new Error('Cannot specify both status and excludeStatuses filters');
    }

    const where: Prisma.WorkspaceWhereInput = { projectId };

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.excludeStatuses && filters.excludeStatuses.length > 0) {
      where.status = { notIn: filters.excludeStatuses };
    }

    if (filters?.kanbanColumn) {
      where.cachedKanbanColumn = filters.kanbanColumn;
    }

    return prisma.workspace.findMany({
      where,
      take: filters?.limit,
      skip: filters?.offset,
      orderBy: { updatedAt: 'desc' },
      include: {
        claudeSessions: true,
        terminalSessions: true,
      },
    });
  }

  update(id: string, data: UpdateWorkspaceInput): Promise<Workspace> {
    return prisma.workspace.update({
      where: { id },
      data,
    });
  }

  delete(id: string): Promise<Workspace> {
    return prisma.workspace.delete({
      where: { id },
    });
  }

  // Note: archive functionality is provided by workspaceStateMachine.archive()

  /**
   * Find workspaces that need worktree creation or recovery.
   * Returns:
   * - NEW workspaces that haven't started provisioning yet
   * - PROVISIONING workspaces that are stale (>10 minutes) and likely stuck due to server crash
   *
   * Used for reconciliation to ensure all workspaces are initialized.
   * Includes project for worktree creation.
   */
  findNeedingWorktree(): Promise<WorkspaceWithProject[]> {
    const staleThreshold = new Date(Date.now() - STALE_PROVISIONING_THRESHOLD_MS);

    return prisma.workspace.findMany({
      where: {
        OR: [
          { status: 'NEW' },
          {
            status: 'PROVISIONING',
            initStartedAt: { lt: staleThreshold },
          },
        ],
      },
      include: {
        project: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Find workspace by ID with project included.
   * Used when project info is needed (e.g., for worktree creation).
   */
  findByIdWithProject(id: string): Promise<WorkspaceWithProject | null> {
    return prisma.workspace.findUnique({
      where: { id },
      include: {
        project: true,
      },
    });
  }

  /**
   * Find READY workspaces with PR URLs that need sync.
   * Used for Inngest PR status sync job.
   */
  findNeedingPRSync(staleThresholdMinutes = 5): Promise<WorkspaceWithProject[]> {
    const staleThreshold = new Date(Date.now() - staleThresholdMinutes * 60 * 1000);

    return prisma.workspace.findMany({
      where: {
        status: 'READY',
        prUrl: { not: null },
        OR: [{ prUpdatedAt: null }, { prUpdatedAt: { lt: staleThreshold } }],
      },
      include: {
        project: true,
      },
      orderBy: { prUpdatedAt: 'asc' }, // Oldest first
    });
  }

  /**
   * Find READY workspaces without PR URLs that have a branch name.
   * Used for detecting newly created PRs.
   */
  findNeedingPRDiscovery(): Promise<WorkspaceWithProject[]> {
    return prisma.workspace.findMany({
      where: {
        status: 'READY',
        prUrl: null,
        branchName: { not: null },
      },
      include: {
        project: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Find ACTIVE workspaces with PR URLs for CI monitoring.
   * Returns workspaces that have PRs to monitor for CI status changes.
   */
  findWithPRsForCIMonitoring(): Promise<
    Array<{
      id: string;
      prUrl: string;
      prCiStatus: CIStatus;
      prCiFailedAt: Date | null;
      prCiLastNotifiedAt: Date | null;
    }>
  > {
    return prisma.workspace.findMany({
      where: {
        status: 'READY',
        prUrl: { not: null },
      },
      select: {
        id: true,
        prUrl: true,
        prCiStatus: true,
        prCiFailedAt: true,
        prCiLastNotifiedAt: true,
      },
      orderBy: { prUpdatedAt: 'asc' },
    }) as Promise<
      Array<{
        id: string;
        prUrl: string;
        prCiStatus: CIStatus;
        prCiFailedAt: Date | null;
        prCiLastNotifiedAt: Date | null;
      }>
    >;
  }

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
   * Find multiple workspaces by their IDs.
   * Used for batch lookups when enriching process info.
   */
  findByIds(ids: string[]): Promise<Workspace[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return prisma.workspace.findMany({
      where: {
        id: { in: ids },
      },
    });
  }

  /**
   * Find multiple workspaces by their IDs with project included.
   * Used for batch lookups when project info is needed (e.g., admin process list).
   */
  findByIdsWithProject(ids: string[]): Promise<WorkspaceWithProject[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return prisma.workspace.findMany({
      where: {
        id: { in: ids },
      },
      include: {
        project: true,
      },
    });
  }
}

export const workspaceAccessor = new WorkspaceAccessor();
