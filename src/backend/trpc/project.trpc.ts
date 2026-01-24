import { z } from 'zod';
import { projectAccessor } from '../resource_accessors/project.accessor.js';
import { publicProcedure, router } from './trpc.js';

export const projectRouter = router({
  // List all projects
  list: publicProcedure
    .input(
      z
        .object({
          isArchived: z.boolean().optional(),
          limit: z.number().min(1).max(100).optional(),
          offset: z.number().min(0).optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      return projectAccessor.list(input);
    }),

  // Get project by ID
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const project = await projectAccessor.findById(input.id);
    if (!project) {
      throw new Error(`Project not found: ${input.id}`);
    }
    return project;
  }),

  // Get project by slug
  getBySlug: publicProcedure.input(z.object({ slug: z.string() })).query(async ({ input }) => {
    const project = await projectAccessor.findBySlug(input.slug);
    if (!project) {
      throw new Error(`Project not found: ${input.slug}`);
    }
    return project;
  }),

  // Create a new project
  create: publicProcedure
    .input(
      z.object({
        name: z.string().min(1, 'Name is required'),
        slug: z
          .string()
          .min(1, 'Slug is required')
          .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
        repoPath: z.string().min(1, 'Repository path is required'),
        worktreeBasePath: z.string().min(1, 'Worktree base path is required'),
        defaultBranch: z.string().optional(),
        githubOwner: z.string().optional(),
        githubRepo: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Validate repo path
      const repoValidation = await projectAccessor.validateRepoPath(input.repoPath);
      if (!repoValidation.valid) {
        throw new Error(`Invalid repository path: ${repoValidation.error}`);
      }

      // Validate worktree base path
      const worktreeValidation = await projectAccessor.validateWorktreeBasePath(
        input.worktreeBasePath
      );
      if (!worktreeValidation.valid) {
        throw new Error(`Invalid worktree base path: ${worktreeValidation.error}`);
      }

      return projectAccessor.create(input);
    }),

  // Update a project
  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        repoPath: z.string().min(1).optional(),
        worktreeBasePath: z.string().min(1).optional(),
        defaultBranch: z.string().optional(),
        githubOwner: z.string().optional(),
        githubRepo: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...updates } = input;

      // Validate new repo path if provided
      if (updates.repoPath) {
        const repoValidation = await projectAccessor.validateRepoPath(updates.repoPath);
        if (!repoValidation.valid) {
          throw new Error(`Invalid repository path: ${repoValidation.error}`);
        }
      }

      // Validate new worktree base path if provided
      if (updates.worktreeBasePath) {
        const worktreeValidation = await projectAccessor.validateWorktreeBasePath(
          updates.worktreeBasePath
        );
        if (!worktreeValidation.valid) {
          throw new Error(`Invalid worktree base path: ${worktreeValidation.error}`);
        }
      }

      return projectAccessor.update(id, updates);
    }),

  // Archive a project (soft delete)
  archive: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    return projectAccessor.archive(input.id);
  }),

  // Validate repo path
  validateRepoPath: publicProcedure
    .input(z.object({ repoPath: z.string() }))
    .query(async ({ input }) => {
      return projectAccessor.validateRepoPath(input.repoPath);
    }),
});
