import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { projectManagementService } from '@/backend/domains/workspace';
import { gitCommandC } from '@/backend/lib/shell';
import { cryptoService } from '@/backend/services/crypto.service';
import { FactoryConfigService } from '@/backend/services/factory-config.service';
import { IssueProvider } from '@/shared/core/enums';
import { FactoryConfigSchema } from '@/shared/schemas/factory-config.schema';
import {
  IssueTrackerConfigSchema,
  sanitizeIssueTrackerConfig,
} from '@/shared/schemas/issue-tracker-config.schema';
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

async function validateStartupScriptFields(
  id: string,
  updates: {
    startupScriptCommand?: string | null;
    startupScriptPath?: string | null;
  }
) {
  if (updates.startupScriptCommand === undefined && updates.startupScriptPath === undefined) {
    return;
  }

  const currentProject = await projectManagementService.findById(id);
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
      const projects = await projectManagementService.list(input);
      return projects.map((project) => ({
        ...project,
        issueTrackerConfig: sanitizeIssueTrackerConfig(project.issueTrackerConfig),
      }));
    }),

  // Get project by ID
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const project = await projectManagementService.findById(input.id);
    if (!project) {
      throw new Error(`Project not found: ${input.id}`);
    }
    return {
      ...project,
      issueTrackerConfig: sanitizeIssueTrackerConfig(project.issueTrackerConfig),
    };
  }),

  // Get project by slug
  getBySlug: publicProcedure.input(z.object({ slug: z.string() })).query(async ({ input }) => {
    const project = await projectManagementService.findBySlug(input.slug);
    if (!project) {
      throw new Error(`Project not found: ${input.slug}`);
    }
    return {
      ...project,
      issueTrackerConfig: sanitizeIssueTrackerConfig(project.issueTrackerConfig),
    };
  }),

  // List local + remote branches for a project
  listBranches: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      const project = await projectManagementService.findById(input.projectId);
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
      const { startupScriptCommand, startupScriptPath, startupScriptTimeout } = input;

      // Validate only one of command or path is set
      if (startupScriptCommand && startupScriptPath) {
        throw new Error('Cannot specify both startupScriptCommand and startupScriptPath');
      }

      // Validate repo path
      const repoValidation = await projectManagementService.validateRepoPath(input.repoPath);
      if (!repoValidation.valid) {
        throw new Error(`Invalid repository path: ${repoValidation.error}`);
      }

      return projectManagementService.create(
        {
          repoPath: input.repoPath,
          startupScriptCommand,
          startupScriptPath,
          startupScriptTimeout,
        },
        {
          worktreeBaseDir: configService.getWorktreeBaseDir(),
        }
      );
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
        // Issue provider configuration
        issueProvider: z.enum([IssueProvider.GITHUB, IssueProvider.LINEAR]).optional(),
        issueTrackerConfig: IssueTrackerConfigSchema.nullable().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...updates } = input;

      // Validate new repo path if provided
      if (updates.repoPath) {
        const repoValidation = await projectManagementService.validateRepoPath(updates.repoPath);
        if (!repoValidation.valid) {
          throw new Error(`Invalid repository path: ${repoValidation.error}`);
        }
      }

      await validateStartupScriptFields(id, updates);

      // Encrypt Linear API key before persisting
      if (updates.issueTrackerConfig?.linear?.apiKey) {
        updates.issueTrackerConfig = {
          ...updates.issueTrackerConfig,
          linear: {
            ...updates.issueTrackerConfig.linear,
            apiKey: cryptoService.encrypt(updates.issueTrackerConfig.linear.apiKey),
          },
        };
      }

      return projectManagementService.update(id, updates);
    }),

  // Archive a project (soft delete)
  archive: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) => {
    return projectManagementService.archive(input.id);
  }),

  // Validate repo path
  validateRepoPath: publicProcedure.input(z.object({ repoPath: z.string() })).query(({ input }) => {
    return projectManagementService.validateRepoPath(input.repoPath);
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

  // Save factory-factory.json to the project repo
  saveFactoryConfig: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        config: FactoryConfigSchema,
      })
    )
    .mutation(async ({ input }) => {
      const project = await projectManagementService.findById(input.projectId);
      if (!project) {
        throw new Error('Project not found');
      }

      const configContent = JSON.stringify(input.config, null, 2);
      await writeFile(join(project.repoPath, 'factory-factory.json'), configContent, 'utf-8');

      return { success: true };
    }),
});
