import { z } from 'zod';
import { prisma } from '@/backend/db';
import type { WorkspaceStatus } from '@prisma-gen/client';

export interface BranchCleanupProject {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  isArchived: boolean;
}

/** A merged pull request's head branch and the head commit GitHub last reported for it. */
export interface MergedPrHead {
  branch: string;
  sha: string;
}

export interface BranchCleanupWorkspace {
  projectId: string;
  status: WorkspaceStatus;
  branchName: string;
  /** Null when no worktree was ever created, so `branchName` may still be the base branch. */
  worktreePath: string | null;
  /** Attached pull requests that GitHub reported merged, with a known head commit. */
  mergedPrHeads: MergedPrHead[];
}

const mergedPrHeadRowSchema = z.object({
  workspaceId: z.string(),
  branch: z.string().min(1),
  sha: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
});

/** Reads for the archived-branch cleanup. Selects only narrow columns; never blobs. */
class WorkspaceBranchCleanupAccessor {
  listProjects(): Promise<BranchCleanupProject[]> {
    return prisma.project.findMany({
      select: { id: true, name: true, repoPath: true, defaultBranch: true, isArchived: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  async listWorkspacesWithBranches(): Promise<BranchCleanupWorkspace[]> {
    const [rows, mergedHeads] = await Promise.all([
      prisma.workspace.findMany({
        where: { branchName: { not: null } },
        select: { id: true, projectId: true, status: true, branchName: true, worktreePath: true },
      }),
      this.listMergedPrHeads(),
    ]);
    return rows.flatMap(({ id, branchName, ...row }) =>
      branchName ? [{ ...row, branchName, mergedPrHeads: mergedHeads.get(id) ?? [] }] : []
    );
  }

  /**
   * Head commits of attached, merged pull requests. SQLite extracts only
   * `headSha` from the stored observation, so the blob never reaches Node; a
   * row without a valid observation or head commit is left out.
   */
  private async listMergedPrHeads(): Promise<Map<string, MergedPrHead[]>> {
    const rows = await prisma.$queryRaw<unknown[]>`
      SELECT "workspaceId", "headRefName" AS "branch",
        json_extract("observation", '$.headSha') AS "sha"
      FROM "WorkspacePR"
      WHERE "state" = 'MERGED' AND "detachedAt" IS NULL AND "headRefName" IS NOT NULL
        AND json_valid("observation")`;
    const heads = new Map<string, MergedPrHead[]>();
    for (const row of rows) {
      const parsed = mergedPrHeadRowSchema.safeParse(row);
      if (parsed.success) {
        const { workspaceId, branch, sha } = parsed.data;
        heads.set(workspaceId, [...(heads.get(workspaceId) ?? []), { branch, sha }]);
      }
    }
    return heads;
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
