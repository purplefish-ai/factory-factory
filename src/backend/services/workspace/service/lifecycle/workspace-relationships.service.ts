import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';

class WorkspaceRelationshipsService {
  findChildrenWithStatus(parentWorkspaceId: string) {
    return workspaceAccessor.findChildrenWithStatus(parentWorkspaceId);
  }

  /** Live child rows in every status plus retained origins, including deleted children. */
  findChildRestFacts(parentWorkspaceId: string) {
    return workspaceAccessor.findChildRestFacts(parentWorkspaceId);
  }

  findParent(childWorkspaceId: string) {
    return workspaceAccessor.findParentWorkspace(childWorkspaceId);
  }
}

export const workspaceRelationshipsService = new WorkspaceRelationshipsService();
