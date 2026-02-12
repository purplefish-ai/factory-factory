import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import type { Prisma, Project } from '@prisma-gen/client';
import { GitClientFactory } from '@/backend/clients/git.client';
import { prisma } from '@/backend/db';
import { gitCommandC } from '@/backend/lib/shell';

/**
 * Execute a command with proper argument separation (no shell injection).
 */
function execCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || `Command exited with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

// Type for Project with workspaces relation included
type ProjectWithWorkspaces = Prisma.ProjectGetPayload<{
  include: { workspaces: true };
}>;

// Simplified input - only repoPath is required
interface CreateProjectInput {
  repoPath: string;
  startupScriptCommand?: string;
  startupScriptPath?: string;
  startupScriptTimeout?: number;
}

interface UpdateProjectInput {
  name?: string;
  repoPath?: string;
  defaultBranch?: string;
  githubOwner?: string;
  githubRepo?: string;
  isArchived?: boolean;
  // Startup script configuration
  startupScriptCommand?: string | null;
  startupScriptPath?: string | null;
  startupScriptTimeout?: number;
}

interface ListProjectsFilters {
  isArchived?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Derive project name from repository path.
 * Uses the last directory component of the path.
 */
function deriveNameFromPath(repoPath: string): string {
  const basename = path.basename(repoPath);
  // Convert kebab-case or snake_case to Title Case
  return basename.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Derive slug from repository path.
 * Uses the last directory component, lowercased and sanitized.
 */
function deriveSlugFromPath(repoPath: string): string {
  return path
    .basename(repoPath)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Parse GitHub owner and repo from a git remote URL.
 * Supports both SSH and HTTPS formats:
 * - git@github.com:owner/repo.git
 * - https://github.com/owner/repo.git
 * - https://github.com/owner/repo
 * Returns null if the URL is not a GitHub URL or cannot be parsed.
 */
export function parseGitHubRemoteUrl(remoteUrl: string): { owner: string; repo: string } | null {
  // SSH format: git@github.com:owner/repo.git
  // Repo name: alphanumeric, hyphens, underscores, dots (no slashes)
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1] as string, repo: sshMatch[2] as string };
  }

  // HTTPS format: https://github.com/owner/repo.git or https://github.com/owner/repo
  // Repo name: alphanumeric, hyphens, underscores, dots (no slashes)
  const httpsMatch = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1] as string, repo: httpsMatch[2] as string };
  }

  return null;
}

/**
 * Get GitHub owner/repo info from a git repository's remote.
 * Checks the 'origin' remote first.
 */
async function getGitHubInfoFromRepo(
  repoPath: string
): Promise<{ owner: string; repo: string } | null> {
  try {
    const result = await gitCommandC(repoPath, ['remote', 'get-url', 'origin']);
    if (result.code !== 0) {
      return null;
    }
    const remoteUrl = result.stdout.trim();
    return parseGitHubRemoteUrl(remoteUrl);
  } catch {
    return null;
  }
}

/**
 * Compute the worktree path for a project.
 */
function computeWorktreePath(worktreeBaseDir: string, slug: string): string {
  return path.join(worktreeBaseDir, slug);
}

/**
 * Context for project creation operations.
 * Configuration values are passed in to maintain layer separation.
 */
export interface ProjectAccessorContext {
  worktreeBaseDir: string;
}

class ProjectAccessor {
  /**
   * Create a new project from a repository path.
   * Name, slug, and worktree path are auto-derived.
   * GitHub owner/repo are auto-detected from git remote if available.
   * If slug conflicts, appends a counter suffix (e.g., "my-project-2").
   *
   * @param data - Project creation input (repoPath)
   * @param context - Configuration context including worktreeBaseDir
   */
  async create(data: CreateProjectInput, context: ProjectAccessorContext): Promise<Project> {
    const name = deriveNameFromPath(data.repoPath);
    const baseSlug = deriveSlugFromPath(data.repoPath);

    // Auto-detect GitHub info from git remote
    const githubInfo = await getGitHubInfoFromRepo(data.repoPath);

    // Try base slug first, then with counter suffix if it conflicts
    let slug = baseSlug;
    let counter = 1;
    const maxAttempts = 100;

    while (counter <= maxAttempts) {
      const worktreeBasePath = computeWorktreePath(context.worktreeBaseDir, slug);

      try {
        return await prisma.project.create({
          data: {
            name: counter === 1 ? name : `${name} ${counter}`,
            slug,
            repoPath: data.repoPath,
            worktreeBasePath,
            defaultBranch: 'main',
            githubOwner: githubInfo?.owner ?? null,
            githubRepo: githubInfo?.repo ?? null,
            startupScriptCommand: data.startupScriptCommand ?? null,
            startupScriptPath: data.startupScriptPath ?? null,
            startupScriptTimeout: data.startupScriptTimeout ?? 300,
          },
        });
      } catch (error) {
        // Check if it's a unique constraint violation on slug
        if (
          error instanceof Error &&
          error.message.includes('Unique constraint') &&
          error.message.includes('slug')
        ) {
          counter++;
          slug = `${baseSlug}-${counter}`;
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Unable to create project: too many projects with similar names`);
  }

  findById(id: string): Promise<ProjectWithWorkspaces | null> {
    return prisma.project.findUnique({
      where: { id },
      include: {
        workspaces: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
  }

  findBySlug(slug: string): Promise<ProjectWithWorkspaces | null> {
    return prisma.project.findUnique({
      where: { slug },
      include: {
        workspaces: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
  }

  update(id: string, data: UpdateProjectInput): Promise<Project> {
    return prisma.project.update({
      where: { id },
      data,
    });
  }

  list(filters?: ListProjectsFilters) {
    const where: Prisma.ProjectWhereInput = {};

    if (filters?.isArchived !== undefined) {
      where.isArchived = filters.isArchived;
    }

    return prisma.project.findMany({
      where,
      take: filters?.limit,
      skip: filters?.offset,
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: {
          select: {
            workspaces: {
              where: { status: { not: 'ARCHIVED' } },
            },
          },
        },
      },
    });
  }

  archive(id: string): Promise<Project> {
    return prisma.project.update({
      where: { id },
      data: { isArchived: true },
    });
  }

  async delete(id: string): Promise<Project> {
    // Get project first to evict from cache
    const project = await prisma.project.findUnique({ where: { id } });
    if (project) {
      GitClientFactory.removeProject({
        repoPath: project.repoPath,
        worktreeBasePath: project.worktreeBasePath,
      });
    }

    return prisma.project.delete({
      where: { id },
    });
  }

  /**
   * Validate that a path is a valid git repository.
   */
  async validateRepoPath(repoPath: string): Promise<{ valid: boolean; error?: string }> {
    try {
      // Check if path exists and is readable
      await access(repoPath, constants.R_OK);

      // Check if it's a git repository (using spawn with args to prevent injection)
      await execCommand('git', ['-C', repoPath, 'rev-parse', '--git-dir']);

      return { valid: true };
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('ENOENT')) {
          return { valid: false, error: 'Path does not exist' };
        }
        if (error.message.includes('EACCES')) {
          return { valid: false, error: 'Path is not accessible' };
        }
        if (error.message.includes('not a git repository')) {
          return { valid: false, error: 'Path is not a git repository' };
        }
        return { valid: false, error: error.message };
      }
      return { valid: false, error: 'Unknown error' };
    }
  }
}

export const projectAccessor = new ProjectAccessor();
