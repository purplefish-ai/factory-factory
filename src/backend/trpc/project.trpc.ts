import { z } from 'zod';
import { prisma } from '../db';
import { gitCommandC } from '../lib/shell';
import { projectAccessor } from '../resource_accessors/project.accessor';
import { FactoryConfigService } from '../services/factory-config.service';
import { publicProcedure, router } from './trpc';

async function getBranchMap(repoPath: string, refPrefix: string): Promise<Map<string, string>> {
  const result = await gitCommandC(repoPath, [
    'for-each-ref',
    '--format=%(refname:short) %(objectname)',
    refPrefix,
  ]);
  if (result.code !== 0) {
    throw new Error(`Failed to list branches: ${result.stderr || result.stdout}`);
  }

  const branchMap = new Map<string, string>();
  const lines = result.stdout.split('\n').filter(Boolean);
  for (const line of lines) {
    const firstSpace = line.indexOf(' ');
    if (firstSpace === -1) {
      continue;
    }
    const name = line.slice(0, firstSpace);
    const sha = line.slice(firstSpace + 1).trim();
    if (name && sha) {
      branchMap.set(name, sha);
    }
  }

  return branchMap;
}

function buildRemoteEntries(
  localMap: Map<string, string>,
  remoteMap: Map<string, string>
): Array<{ name: string; displayName: string; refType: 'remote' }> {
  const entries: Array<{ name: string; displayName: string; refType: 'remote' }> = [];

  for (const [fullName, sha] of remoteMap.entries()) {
    if (fullName === 'origin/HEAD') {
      continue;
    }
    const shortName = fullName.replace(/^origin\//, '');
    const localSha = localMap.get(shortName);
    if (localSha && localSha === sha) {
      continue;
    }
    entries.push({
      name: fullName,
      displayName: localSha ? fullName : shortName,
      refType: 'remote',
    });
  }

  return entries;
}

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

  // List local + remote branches for a project
  listBranches: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      const project = await projectAccessor.findById(input.projectId);
      if (!project) {
        throw new Error(`Project not found: ${input.projectId}`);
      }

      const localMap = await getBranchMap(project.repoPath, 'refs/heads');
      const remoteMap = await getBranchMap(project.repoPath, 'refs/remotes/origin');

      const remoteEntries = buildRemoteEntries(localMap, remoteMap);

      const localBranches = Array.from(localMap.keys()).map((branch) => ({
        name: branch,
        displayName: branch,
        refType: 'local' as const,
      }));

      const branches = [...localBranches, ...remoteEntries].sort((a, b) =>
        a.displayName.localeCompare(b.displayName)
      );

      return { branches };
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
    .mutation(async ({ ctx, input }) => {
      const { configService } = ctx.appContext.services;
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

      // Validate only one of command or path is set (check final state, not just request)
      if (updates.startupScriptCommand !== undefined || updates.startupScriptPath !== undefined) {
        const currentProject = await prisma.project.findUnique({
          where: { id },
          select: { startupScriptCommand: true, startupScriptPath: true },
        });

        if (!currentProject) {
          throw new Error(`Project not found: ${id}`);
        }

        const finalCommand =
          updates.startupScriptCommand !== undefined
            ? updates.startupScriptCommand
            : currentProject.startupScriptCommand;

        const finalPath =
          updates.startupScriptPath !== undefined
            ? updates.startupScriptPath
            : currentProject.startupScriptPath;

        if (finalCommand && finalPath) {
          throw new Error(
            'Cannot have both startupScriptCommand and startupScriptPath set. Please clear one by setting it to null.'
          );
        }
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

  // Check if factory-factory.json exists in the repository
  checkFactoryConfig: publicProcedure
    .input(z.object({ repoPath: z.string() }))
    .query(async ({ input }) => {
      try {
        const config = await FactoryConfigService.readConfig(input.repoPath);
        return { exists: config !== null };
      } catch {
        return { exists: false };
      }
    }),
});
