import { prisma } from '@/backend/db';
import type { WorkspaceStatus } from '@prisma-gen/client';

export interface BranchCleanupProject {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  isArchived: boolean;
}

export interface BranchCleanupWorkspace {
  projectId: string;
  status: WorkspaceStatus;
  branchName: string;
  /** Null when no worktree was ever created, so `branchName` may still be the base branch. */
  worktreePath: string | null;
  /** Head branches of the workspace's attached pull requests that GitHub reported merged. */
  mergedPrHeadBranches: string[];
}

/** Reads for the archived-branch cleanup. Selects only narrow columns; never blobs. */
class WorkspaceBranchCleanupAccessor {
  listProjects(): Promise<BranchCleanupProject[]> {
    return prisma.project.findMany({
      select: { id: true, name: true, repoPath: true, defaultBranch: true, isArchived: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  async listWorkspacesWithBranches(): Promise<BranchCleanupWorkspace[]> {
    const rows = await prisma.workspace.findMany({
      where: { branchName: { not: null } },
      select: {
        projectId: true,
        status: true,
        branchName: true,
        worktreePath: true,
        prs: {
          where: { state: 'MERGED', detachedAt: null, headRefName: { not: null } },
          select: { headRefName: true },
        },
      },
    });
    return rows.flatMap(({ branchName, prs, ...row }) =>
      branchName
        ? [
            {
              ...row,
              branchName,
              mergedPrHeadBranches: prs.flatMap((pr) => (pr.headRefName ? [pr.headRefName] : [])),
            },
          ]
        : []
    );
  }

  /** Whether a workspace that is not ARCHIVED, in any of the projects, records this branch. */
  async hasNonArchivedWorkspaceWithBranch(
    projectIds: string[],
    branchName: string
  ): Promise<boolean> {
    const row = await prisma.workspace.findFirst({
      where: { projectId: { in: projectIds }, branchName, status: { not: 'ARCHIVED' } },
      select: { id: true },
    });
    return row !== null;
  }
}

export const workspaceBranchCleanupAccessor = new WorkspaceBranchCleanupAccessor();
