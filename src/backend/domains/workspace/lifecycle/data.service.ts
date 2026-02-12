import type { Workspace, WorkspaceStatus } from '@prisma-gen/client';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';

class WorkspaceDataService {
  findById(id: string) {
    return workspaceAccessor.findById(id);
  }

  findByIdWithProject(id: string) {
    return workspaceAccessor.findByIdWithProject(id);
  }

  findByProjectId(
    projectId: string,
    filters?: { status?: WorkspaceStatus; limit?: number; offset?: number }
  ) {
    return workspaceAccessor.findByProjectId(projectId, filters);
  }

  findByIdsWithProject(ids: string[]) {
    return workspaceAccessor.findByIdsWithProject(ids);
  }

  setBranchName(id: string, branchName: string) {
    return workspaceAccessor.update(id, { branchName });
  }

  setRunScriptCommands(
    id: string,
    runScriptCommand: string | null,
    runScriptCleanupCommand: string | null
  ) {
    return workspaceAccessor.update(id, {
      runScriptCommand,
      runScriptCleanupCommand,
    });
  }

  delete(id: string): Promise<Workspace> {
    return workspaceAccessor.delete(id);
  }
}

export const workspaceDataService = new WorkspaceDataService();
