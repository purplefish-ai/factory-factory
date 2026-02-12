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

  update(id: string, data: Parameters<typeof workspaceAccessor.update>[1]) {
    return workspaceAccessor.update(id, data);
  }

  delete(id: string): Promise<Workspace> {
    return workspaceAccessor.delete(id);
  }
}

export const workspaceDataService = new WorkspaceDataService();
