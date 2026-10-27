import type { workspaceDataService, WorkspaceSnapshotStore } from '@/backend/services/workspace';

export type RenamedWorkspace = Awaited<ReturnType<typeof workspaceDataService.rename>>;
export interface WorkspaceRenamePorts {
  rename: typeof workspaceDataService.rename;
  publishAcceptedName: WorkspaceSnapshotStore['publishAcceptedName'];
}

/** One application's accepted rename writer; other workspaces remain independent. */
export function createWorkspaceRename(ports: WorkspaceRenamePorts) {
  const pending = new Map<string, Promise<void>>();
  return {
    get pendingWorkspaceCount() {
      return pending.size;
    },
    rename(id: string, name: string): Promise<RenamedWorkspace> {
      const previous = pending.get(id) ?? Promise.resolve();
      const operation = previous.then(async () => {
        const workspace = await ports.rename(id, name);
        if (workspace.status !== 'ARCHIVING' && workspace.status !== 'ARCHIVED') {
          ports.publishAcceptedName(workspace.id, workspace.name, workspace.updatedAt.getTime());
        }
        return workspace;
      });
      const result = operation.finally(() => {
        if (pending.get(id) === released) {
          pending.delete(id);
        }
      });
      const released = result.then(
        () => undefined,
        () => undefined
      );
      pending.set(id, released);
      return result;
    },
  };
}
