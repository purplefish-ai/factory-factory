import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';

class WorkspaceRelationshipsService {
  findChildrenWithStatus(parentWorkspaceId: string) {
    return workspaceAccessor.findChildrenWithStatus(parentWorkspaceId);
  }

  findParent(childWorkspaceId: string) {
    return workspaceAccessor.findParentWorkspace(childWorkspaceId);
  }
}

export const workspaceRelationshipsService = new WorkspaceRelationshipsService();
