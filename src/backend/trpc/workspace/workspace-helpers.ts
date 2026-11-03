/**
 * Workspace validation helpers for tRPC procedures.
 *
 * Provides reusable functions to look up workspaces and validate their state.
 */

import { TRPCError } from '@trpc/server';
import type { ApplicationServices } from '@/backend/app-context';

type WorkspaceDataService = Pick<
  ApplicationServices['workspaceDataService'],
  'findByIdWithProject' | 'findWorktreeContext'
>;

function notFound(workspaceId: string): TRPCError {
  return new TRPCError({
    code: 'NOT_FOUND',
    message: `Workspace not found: ${workspaceId}`,
  });
}

/**
 * Find a workspace with project by ID or throw a NOT_FOUND error.
 *
 * @throws TRPCError with NOT_FOUND code if workspace doesn't exist
 */
export async function getWorkspaceWithProjectOrThrow(
  workspaceDataService: WorkspaceDataService,
  workspaceId: string
) {
  const workspace = await workspaceDataService.findByIdWithProject(workspaceId);
  if (!workspace) {
    throw notFound(workspaceId);
  }
  return workspace;
}

/**
 * The narrow read behind git and file panels: id, worktree path and the
 * project's default branch. Those panels poll, so they skip the full row
 * (creation metadata, init output, sessions and side tables).
 */
export type WorkspaceWorktreeContext = NonNullable<
  Awaited<ReturnType<WorkspaceDataService['findWorktreeContext']>>
>;

/**
 * Find a workspace's worktree context by ID or throw a NOT_FOUND error.
 *
 * @throws TRPCError with NOT_FOUND code if workspace doesn't exist
 */
export async function getWorkspaceWorktreeContextOrThrow(
  workspaceDataService: WorkspaceDataService,
  workspaceId: string
): Promise<WorkspaceWorktreeContext> {
  const workspace = await workspaceDataService.findWorktreeContext(workspaceId);
  if (!workspace) {
    throw notFound(workspaceId);
  }
  return workspace;
}

/**
 * Result type for workspace with validated worktree.
 */
export interface WorkspaceWithWorktree {
  workspace: WorkspaceWorktreeContext;
  worktreePath: string;
}

/**
 * Find a workspace and validate it has a worktree path.
 *
 * @returns Object with workspace and worktreePath, or null if no worktree
 * @throws TRPCError with NOT_FOUND code if workspace doesn't exist
 */
export async function getWorkspaceWithWorktree(
  workspaceDataService: WorkspaceDataService,
  workspaceId: string
): Promise<WorkspaceWithWorktree | null> {
  const workspace = await getWorkspaceWorktreeContextOrThrow(workspaceDataService, workspaceId);

  if (!workspace.worktreePath) {
    return null;
  }

  return { workspace, worktreePath: workspace.worktreePath };
}

/**
 * Find a workspace and require it has a worktree path.
 *
 * @throws TRPCError with NOT_FOUND if workspace doesn't exist
 * @throws TRPCError with BAD_REQUEST if workspace has no worktree
 */
export async function getWorkspaceWithWorktreeOrThrow(
  workspaceDataService: WorkspaceDataService,
  workspaceId: string
): Promise<WorkspaceWithWorktree> {
  const result = await getWorkspaceWithWorktree(workspaceDataService, workspaceId);
  if (!result) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Workspace has no worktree path',
    });
  }
  return result;
}
