import { exec } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Prisma, Project } from '@prisma-gen/client';
import { prisma } from '../db.js';

const execAsync = promisify(exec);

// Type for Project with epics relation included
export type ProjectWithEpics = Prisma.ProjectGetPayload<{
  include: { epics: true };
}>;

export interface CreateProjectInput {
  name: string;
  slug: string;
  repoPath: string;
  worktreeBasePath: string;
  defaultBranch?: string;
  githubOwner?: string;
  githubRepo?: string;
}

export interface UpdateProjectInput {
  name?: string;
  repoPath?: string;
  worktreeBasePath?: string;
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

export class ProjectAccessor {
  async create(data: CreateProjectInput): Promise<Project> {
    return prisma.project.create({
      data: {
        name: data.name,
        slug: data.slug,
        repoPath: data.repoPath,
        worktreeBasePath: data.worktreeBasePath,
        defaultBranch: data.defaultBranch ?? 'main',
        githubOwner: data.githubOwner,
        githubRepo: data.githubRepo,
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

  /**
   * Validate that a worktree base path is writable.
   */
  async validateWorktreeBasePath(
    worktreeBasePath: string
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      // Check if path exists and is writable (or parent is writable for creation)
      await access(worktreeBasePath, constants.W_OK);
      return { valid: true };
    } catch (error) {
      if (error instanceof Error && error.message.includes('ENOENT')) {
        // Path doesn't exist, that's OK - it will be created
        return { valid: true };
      }
      return { valid: false, error: 'Worktree base path is not writable' };
    }
  }
}

export const projectAccessor = new ProjectAccessor();
