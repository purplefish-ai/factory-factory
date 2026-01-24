import { exec } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Prisma, Project } from '@prisma-gen/client';
import { prisma } from '../db.js';

const execAsync = promisify(exec);

// Type for Project with epics relation included
export type ProjectWithEpics = Prisma.ProjectGetPayload<{
  include: { epics: true };
}>;

// Simplified input - only repoPath is required
export interface CreateProjectInput {
  repoPath: string;
}

export interface UpdateProjectInput {
  name?: string;
  repoPath?: string;
  defaultBranch?: string;
  githubOwner?: string;
  githubRepo?: string;
  isArchived?: boolean;
}

export interface ListProjectsFilters {
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
 * Get the worktree base directory from environment.
 */
function getWorktreeBaseDir(): string {
  const baseDir = process.env.WORKTREE_BASE_DIR;
  if (!baseDir) {
    throw new Error(
      'WORKTREE_BASE_DIR environment variable is required. ' +
        'Set it to the base directory for project worktrees.'
    );
  }
  return baseDir;
}

/**
 * Compute the worktree path for a project.
 */
function computeWorktreePath(slug: string): string {
  return path.join(getWorktreeBaseDir(), slug);
}

export class ProjectAccessor {
  /**
   * Create a new project from a repository path.
   * Name, slug, and worktree path are auto-derived.
   */
  async create(data: CreateProjectInput): Promise<Project> {
    const name = deriveNameFromPath(data.repoPath);
    const slug = deriveSlugFromPath(data.repoPath);
    const worktreeBasePath = computeWorktreePath(slug);

    return prisma.project.create({
      data: {
        name,
        slug,
        repoPath: data.repoPath,
        worktreeBasePath,
        defaultBranch: 'main',
      },
    });
  }

  async findById(id: string): Promise<ProjectWithEpics | null> {
    return prisma.project.findUnique({
      where: { id },
      include: {
        epics: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
  }

  async findBySlug(slug: string): Promise<ProjectWithEpics | null> {
    return prisma.project.findUnique({
      where: { slug },
      include: {
        epics: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
  }

  async update(id: string, data: UpdateProjectInput): Promise<Project> {
    return prisma.project.update({
      where: { id },
      data,
    });
  }

  async list(filters?: ListProjectsFilters): Promise<Project[]> {
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
          select: { epics: true },
        },
      },
    });
  }

  async archive(id: string): Promise<Project> {
    return prisma.project.update({
      where: { id },
      data: { isArchived: true },
    });
  }

  async delete(id: string): Promise<Project> {
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

      // Check if it's a git repository
      await execAsync(`git -C "${repoPath}" rev-parse --git-dir`);

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
