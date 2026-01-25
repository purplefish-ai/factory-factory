import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import type { Prisma, Project } from '@prisma-gen/client';
import { GitClientFactory } from '../clients/git.client.js';
import { prisma } from '../db.js';
import { configService } from '../services/index.js';

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

// Type for Project with tasks relation included
type ProjectWithTasks = Prisma.ProjectGetPayload<{
  include: { tasks: true };
}>;

// Simplified input - only repoPath is required
interface CreateProjectInput {
  repoPath: string;
}

interface UpdateProjectInput {
  name?: string;
  repoPath?: string;
  defaultBranch?: string;
  githubOwner?: string;
  githubRepo?: string;
  isArchived?: boolean;
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
 * Get the worktree base directory from config.
 */
function getWorktreeBaseDir(): string {
  return configService.getWorktreeBaseDir();
}

/**
 * Compute the worktree path for a project.
 */
function computeWorktreePath(slug: string): string {
  return path.join(getWorktreeBaseDir(), slug);
}

class ProjectAccessor {
  /**
   * Create a new project from a repository path.
   * Name, slug, and worktree path are auto-derived.
   * If slug conflicts, appends a counter suffix (e.g., "my-project-2").
   */
  async create(data: CreateProjectInput): Promise<Project> {
    const name = deriveNameFromPath(data.repoPath);
    const baseSlug = deriveSlugFromPath(data.repoPath);

    // Try base slug first, then with counter suffix if it conflicts
    let slug = baseSlug;
    let counter = 1;
    const maxAttempts = 100;

    while (counter <= maxAttempts) {
      const worktreeBasePath = computeWorktreePath(slug);

      try {
        return await prisma.project.create({
          data: {
            name: counter === 1 ? name : `${name} ${counter}`,
            slug,
            repoPath: data.repoPath,
            worktreeBasePath,
            defaultBranch: 'main',
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

  findById(id: string): Promise<ProjectWithTasks | null> {
    return prisma.project.findUnique({
      where: { id },
      include: {
        tasks: {
          where: { parentId: null }, // Only top-level tasks (epics)
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
  }

  findBySlug(slug: string): Promise<ProjectWithTasks | null> {
    return prisma.project.findUnique({
      where: { slug },
      include: {
        tasks: {
          where: { parentId: null }, // Only top-level tasks (epics)
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

  list(filters?: ListProjectsFilters): Promise<Project[]> {
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
          select: { tasks: true },
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
