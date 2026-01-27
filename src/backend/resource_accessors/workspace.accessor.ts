import type {
  KanbanColumn,
  PRState,
  Prisma,
  Workspace,
  WorkspaceInitStatus,
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
  prUpdatedAt?: Date | null;
  // Activity tracking
  hasHadSessions?: boolean;
  // Cached kanban column
  cachedKanbanColumn?: KanbanColumn;
  stateComputedAt?: Date | null;
  // Initialization tracking
  initStatus?: WorkspaceInitStatus;
  initErrorMessage?: string | null;
  initStartedAt?: Date | null;
  initCompletedAt?: Date | null;
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
   * Find ACTIVE workspaces where worktreePath is null.
   * Used for reconciliation to ensure all active workspaces have worktrees.
   * Includes project for worktree creation.
   */
  findNeedingWorktree(): Promise<WorkspaceWithProject[]> {
    return prisma.workspace.findMany({
      where: {
        status: 'ACTIVE',
        worktreePath: null,
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
   * Find ACTIVE workspaces with PR URLs that need sync.
   * Used for Inngest PR status sync job.
   */
  findNeedingPRSync(staleThresholdMinutes = 5): Promise<WorkspaceWithProject[]> {
    const staleThreshold = new Date(Date.now() - staleThresholdMinutes * 60 * 1000);

    return prisma.workspace.findMany({
      where: {
        status: 'ACTIVE',
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
   * Update workspace initialization status atomically.
   * Includes timestamps for tracking.
   */
  updateInitStatus(
    id: string,
    status: WorkspaceInitStatus,
    errorMessage?: string | null
  ): Promise<Workspace> {
    const now = new Date();
    const data: Prisma.WorkspaceUpdateInput = {
      initStatus: status,
    };

    if (status === 'INITIALIZING') {
      data.initStartedAt = now;
      data.initErrorMessage = null;
    } else if (status === 'READY' || status === 'FAILED') {
      data.initCompletedAt = now;
    }

    if (errorMessage !== undefined) {
      data.initErrorMessage = errorMessage;
    }

    return prisma.workspace.update({
      where: { id },
      data,
    });
  }
}

export const workspaceAccessor = new WorkspaceAccessor();
