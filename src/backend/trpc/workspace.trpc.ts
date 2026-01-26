import { WorkspaceStatus } from '@prisma-gen/client';
import { z } from 'zod';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor.js';
import { publicProcedure, router } from './trpc.js';

export const workspaceRouter = router({
  // List workspaces for a project
  list: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        status: z.nativeEnum(WorkspaceStatus).optional(),
        limit: z.number().min(1).max(100).optional(),
        offset: z.number().min(0).optional(),
      })
    )
    .query(({ input }) => {
      const { projectId, ...filters } = input;
      return workspaceAccessor.findByProjectId(projectId, filters);
    }),

  // Get workspace by ID
  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const workspace = await workspaceAccessor.findById(input.id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${input.id}`);
    }
    return workspace;
  }),

  // Create a new workspace
  create: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1),
        description: z.string().optional(),
        branchName: z.string().optional(),
      })
    )
    .mutation(({ input }) => {
      return workspaceAccessor.create(input);
    }),

  // Update a workspace
  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        status: z.nativeEnum(WorkspaceStatus).optional(),
        worktreePath: z.string().optional(),
        branchName: z.string().optional(),
        prUrl: z.string().optional(),
        githubIssueNumber: z.number().optional(),
        githubIssueUrl: z.string().optional(),
      })
    )
    .mutation(({ input }) => {
      const { id, ...updates } = input;
      return workspaceAccessor.update(id, updates);
    }),

  // Archive a workspace
  archive: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) => {
    return workspaceAccessor.archive(input.id);
  }),

  // Delete a workspace
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) => {
    return workspaceAccessor.delete(input.id);
  }),
});
