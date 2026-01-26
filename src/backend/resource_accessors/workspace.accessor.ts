import type { Prisma, Workspace, WorkspaceStatus } from '@prisma-gen/client';
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
}

interface FindByProjectIdFilters {
  status?: WorkspaceStatus;
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

    return prisma.workspace.findMany({
      where,
      take: filters?.limit,
      skip: filters?.offset,
      orderBy: { updatedAt: 'desc' },
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
}

export const workspaceAccessor = new WorkspaceAccessor();
