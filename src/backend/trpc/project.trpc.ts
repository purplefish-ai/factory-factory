import { z } from 'zod';
import { prisma } from '../db';
import { projectAccessor } from '../resource_accessors/project.accessor';
import { configService } from '../services/config.service';
import { publicProcedure, router } from './trpc';

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
    .query(({ input }) => {
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

  // Create a new project (only repoPath required - name/slug/worktree derived)
  create: publicProcedure
    .input(
      z.object({
        repoPath: z.string().min(1, 'Repository path is required'),
        // Startup script configuration (optional at creation time)
        startupScriptCommand: z.string().optional(),
        startupScriptPath: z.string().optional(),
        startupScriptTimeout: z.number().min(1).max(3600).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { startupScriptCommand, startupScriptPath, startupScriptTimeout, ...createInput } =
        input;

      // Validate only one of command or path is set
      if (startupScriptCommand && startupScriptPath) {
        throw new Error('Cannot specify both startupScriptCommand and startupScriptPath');
      }

      // Validate repo path
      const repoValidation = await projectAccessor.validateRepoPath(input.repoPath);
      if (!repoValidation.valid) {
        throw new Error(`Invalid repository path: ${repoValidation.error}`);
      }

      // Use transaction to ensure atomic creation with startup script config
      return prisma.$transaction(async (tx) => {
        // Create the project
        const project = await projectAccessor.create(createInput, {
          worktreeBaseDir: configService.getWorktreeBaseDir(),
        });

        // If startup script config was provided, update the project within the transaction
        if (startupScriptCommand || startupScriptPath || startupScriptTimeout) {
          return tx.project.update({
            where: { id: project.id },
            data: {
              startupScriptCommand: startupScriptCommand ?? null,
              startupScriptPath: startupScriptPath ?? null,
              startupScriptTimeout: startupScriptTimeout ?? 300,
            },
          });
        }

        return project;
      });
    }),

  // Update a project
  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        repoPath: z.string().min(1).optional(),
        defaultBranch: z.string().optional(),
        githubOwner: z.string().optional(),
        githubRepo: z.string().optional(),
        // Startup script configuration
        startupScriptCommand: z.string().nullable().optional(),
        startupScriptPath: z.string().nullable().optional(),
        startupScriptTimeout: z.number().min(1).max(3600).optional(),
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

      // Validate only one of command or path is set
      if (updates.startupScriptCommand && updates.startupScriptPath) {
        throw new Error('Cannot specify both startupScriptCommand and startupScriptPath');
      }

      return projectAccessor.update(id, updates);
    }),

  // Archive a project (soft delete)
  archive: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) => {
    return projectAccessor.archive(input.id);
  }),

  // Validate repo path
  validateRepoPath: publicProcedure.input(z.object({ repoPath: z.string() })).query(({ input }) => {
    return projectAccessor.validateRepoPath(input.repoPath);
  }),
});
