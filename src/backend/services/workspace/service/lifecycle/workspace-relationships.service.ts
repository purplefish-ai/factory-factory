import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';

class WorkspaceRelationshipsService {
  findChildren(parentWorkspaceId: string) {
    return workspaceAccessor.findChildrenByParentId(parentWorkspaceId);
  }

  findChildrenWithStatus(parentWorkspaceId: string) {
    return workspaceAccessor.findChildrenWithStatus(parentWorkspaceId);
  }

  findParent(childWorkspaceId: string) {
    return workspaceAccessor.findParentWorkspace(childWorkspaceId);
  }
}

export const workspaceRelationshipsService = new WorkspaceRelationshipsService();
