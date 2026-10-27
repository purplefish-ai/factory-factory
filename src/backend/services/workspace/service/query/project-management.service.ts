import path from 'node:path';
import { projectAccessor } from '@/backend/services/workspace/resources/project.accessor';
import {
  inspectProjectRepository,
  validateRepositoryPath,
} from '@/backend/services/workspace/service/worktree/project-repository-inspector';
import type { IssueProvider } from '@/shared/core/enums';
import type { IssueTrackerConfig } from '@/shared/schemas/issue-tracker-config.schema';
import type { Project } from '@prisma-gen/client';

interface ProjectCreationContext {
  worktreeBaseDir: string;
}

class ProjectManagementService {
  list(filters?: { isArchived?: boolean; limit?: number; offset?: number }) {
    return projectAccessor.list(filters);
  }

  findById(id: string) {
    return projectAccessor.findById(id);
  }

  findBySlug(slug: string) {
    return projectAccessor.findBySlug(slug);
  }

  validateRepoPath(repoPath: string): Promise<{ valid: boolean; error?: string }> {
    return validateRepositoryPath(repoPath);
  }

  async create(
    data: {
      repoPath: string;
      startupScriptCommand?: string;
      startupScriptPath?: string;
      startupScriptTimeout?: number;
    },
    context: ProjectCreationContext
  ): Promise<Project> {
    const basename = path.basename(data.repoPath);
    const name = basename.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const baseSlug = basename
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!baseSlug) {
      throw new Error(
        `Unable to create project: repo path "${data.repoPath}" does not produce a valid slug`
      );
    }

    const metadata = await inspectProjectRepository(data.repoPath);
    return projectAccessor.create(
      {
        repoPath: data.repoPath,
        ...metadata,
        startupScriptCommand: data.startupScriptCommand ?? null,
        startupScriptPath: data.startupScriptPath ?? null,
        startupScriptTimeout: data.startupScriptTimeout ?? 300,
      },
      (attempt) => {
        // Allocate all slug-dependent fields together for every insertion retry.
        const slug = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
        return {
          name: attempt === 1 ? name : `${name} ${attempt}`,
          slug,
          worktreeBasePath: path.join(context.worktreeBaseDir, slug),
        };
      }
    );
  }

  update(
    id: string,
    data: {
      name?: string;
      repoPath?: string;
      defaultBranch?: string;
      githubOwner?: string;
      githubRepo?: string;
      isArchived?: boolean;
      startupScriptCommand?: string | null;
      startupScriptPath?: string | null;
      startupScriptTimeout?: number;
      issueProvider?: IssueProvider;
      issueTrackerConfig?: IssueTrackerConfig | null;
    }
  ): Promise<Project> {
    return projectAccessor.update(id, data);
  }

  updateIfStartupUnchanged(
    id: string,
    expected: Pick<Project, 'startupScriptCommand' | 'startupScriptPath'>,
    data: Parameters<ProjectManagementService['update']>[1]
  ): Promise<Project | null> {
    return projectAccessor.updateIfStartupUnchanged(id, expected, data);
  }

  archive(id: string): Promise<Project> {
    return projectAccessor.archive(id);
  }
}

export const projectManagementService = new ProjectManagementService();
