import type { Project } from '@prisma-gen/client';
import {
  type ProjectAccessorContext,
  projectAccessor,
} from '@/backend/resource_accessors/project.accessor';

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
    return projectAccessor.validateRepoPath(repoPath);
  }

  create(
    data: {
      repoPath: string;
      startupScriptCommand?: string;
      startupScriptPath?: string;
      startupScriptTimeout?: number;
    },
    context: ProjectAccessorContext
  ): Promise<Project> {
    return projectAccessor.create(data, context);
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
      issueProvider?: 'GITHUB' | 'LINEAR';
      linearApiKey?: string | null;
      linearTeamId?: string | null;
      linearTeamName?: string | null;
    }
  ): Promise<Project> {
    return projectAccessor.update(id, data);
  }

  archive(id: string): Promise<Project> {
    return projectAccessor.archive(id);
  }
}

export const projectManagementService = new ProjectManagementService();
