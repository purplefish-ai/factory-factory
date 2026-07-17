/**
 * Workspace validation helpers for tRPC procedures.
 *
 * Provides reusable functions to look up workspaces and validate their state.
 */

import { TRPCError } from '@trpc/server';
import type { ApplicationServices } from '@/backend/app-context';

type WorkspaceDataService = Pick<
  ApplicationServices['workspaceDataService'],
  'findById' | 'findByIdWithProject'
>;

/**
 * Find a workspace by ID or throw a NOT_FOUND error.
 *
 * @throws TRPCError with NOT_FOUND code if workspace doesn't exist
 */
export async function getWorkspaceOrThrow(
  workspaceDataService: WorkspaceDataService,
  workspaceId: string
) {
  const workspace = await workspaceDataService.findById(workspaceId);
  if (!workspace) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `Workspace not found: ${workspaceId}`,
    });
  }
  return workspace;
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
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `Workspace not found: ${workspaceId}`,
    });
  }
  return workspace;
}

/**
 * Result type for workspace with validated worktree.
 */
export interface WorkspaceWithWorktree {
  workspace: NonNullable<Awaited<ReturnType<WorkspaceDataService['findById']>>>;
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
  const workspace = await getWorkspaceOrThrow(workspaceDataService, workspaceId);

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
  const workspace = await getWorkspaceOrThrow(workspaceDataService, workspaceId);

  if (!workspace.worktreePath) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Workspace has no worktree path',
    });
  }

  return { workspace, worktreePath: workspace.worktreePath };
}

/**
 * Result type for workspace with project and validated worktree.
 */
export interface WorkspaceWithProjectAndWorktree {
  workspace: NonNullable<Awaited<ReturnType<WorkspaceDataService['findByIdWithProject']>>>;
  worktreePath: string;
}

/**
 * Find a workspace with project and require it has a worktree path.
 *
 * @throws TRPCError with NOT_FOUND if workspace doesn't exist
 * @throws TRPCError with BAD_REQUEST if workspace has no worktree
 */
export async function getWorkspaceWithProjectAndWorktreeOrThrow(
  workspaceDataService: WorkspaceDataService,
  workspaceId: string
): Promise<WorkspaceWithProjectAndWorktree> {
  const workspace = await workspaceDataService.findByIdWithProject(workspaceId);
  if (!workspace) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `Workspace not found: ${workspaceId}`,
    });
  }

  if (!workspace.worktreePath) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Workspace has no worktree path',
    });
  }

  return { workspace, worktreePath: workspace.worktreePath };
}
