import type {
  CIStatus,
  KanbanColumn,
  PRState,
  Prisma,
  Workspace,
  WorkspaceStatus,
} from '@prisma-gen/client';
import { prisma } from '../db';

interface CreateWorkspaceInput {
  projectId: string;
  name: string;
  description?: string;
  branchName?: string;
}

interface UpdateWorkspaceInput {
  name?: string;
  description?: string;
  status?: WorkspaceStatus;
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
  // Activity tracking
  hasHadSessions?: boolean;
  // Cached kanban column
  cachedKanbanColumn?: KanbanColumn;
  stateComputedAt?: Date | null;
  // Provisioning tracking
  errorMessage?: string | null;
  provisioningStartedAt?: Date | null;
  provisioningCompletedAt?: Date | null;
  retryCount?: number;
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
   */
  findByProjectIdWithSessions(
    projectId: string,
    filters?: FindByProjectIdFilters
  ): Promise<WorkspaceWithSessions[]> {
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

  archive(id: string): Promise<Workspace> {
    return prisma.workspace.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    });
  }

  /**
   * Find workspaces that need worktree provisioning.
   * - NEW workspaces always need provisioning
   * - FAILED workspaces only if they don't have a worktree yet
   *   (failure during startup script means worktree exists)
   * Includes project for worktree creation.
   */
  findNeedingWorktree(): Promise<WorkspaceWithProject[]> {
    return prisma.workspace.findMany({
      where: {
        OR: [{ status: 'NEW' }, { status: 'FAILED', worktreePath: null }],
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

  /**
   * Update workspace provisioning status atomically.
   * Includes timestamps for tracking.
   *
   * IMPORTANT: Only updates if workspace is not ARCHIVED, to prevent
   * race conditions where provisioning completion overwrites user's archive action.
   */
  async updateProvisioningStatus(
    id: string,
    status: 'PROVISIONING' | 'READY' | 'FAILED',
    errorMessage?: string | null
  ): Promise<Workspace> {
    const now = new Date();
    const data: Prisma.WorkspaceUpdateInput = {
      status: status,
    };

    if (status === 'PROVISIONING') {
      data.provisioningStartedAt = now;
      data.errorMessage = null;
    } else if (status === 'READY' || status === 'FAILED') {
      data.provisioningCompletedAt = now;
    }

    if (errorMessage !== undefined) {
      data.errorMessage = errorMessage;
    }

    // Use updateMany with status check to prevent race condition with archive
    const result = await prisma.workspace.updateMany({
      where: {
        id,
        status: { not: 'ARCHIVED' },
      },
      data,
    });

    // If no rows updated, workspace was likely archived - return current state
    if (result.count === 0) {
      const workspace = await prisma.workspace.findUnique({ where: { id } });
      if (!workspace) {
        throw new Error(`Workspace not found: ${id}`);
      }
      return workspace;
    }

    // Return the updated workspace
    const workspace = await prisma.workspace.findUnique({ where: { id } });
    if (!workspace) {
      throw new Error(`Workspace not found: ${id}`);
    }
    return workspace;
  }

  /**
   * Increment retry count and reset status for a retry attempt.
   * Returns null if max retries exceeded.
   *
   * @param maxRetries - Maximum number of retries allowed (default 3)
   */
  async incrementRetryCount(id: string, maxRetries = 3): Promise<Workspace | null> {
    // Use raw update to atomically check and increment
    const result = await prisma.workspace.updateMany({
      where: {
        id,
        retryCount: { lt: maxRetries },
      },
      data: {
        retryCount: { increment: 1 },
        status: 'PROVISIONING',
        provisioningStartedAt: new Date(),
        errorMessage: null,
      },
    });

    if (result.count === 0) {
      return null; // Max retries exceeded
    }

    return prisma.workspace.findUnique({ where: { id } });
  }
}

export const workspaceAccessor = new WorkspaceAccessor();
