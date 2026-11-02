import type { DataBackupTransactionClient } from '@/backend/services/settings';
import type { ExportData } from '@/shared/schemas/export-data.schema';

/** Existing IDs alone convey no authority to attach an imported descendant. */
export async function selectRecoveryGraph(
  data: ExportData['data'],
  tx: DataBackupTransactionClient,
  projects: ReadonlySet<string>
) {
  const children = new Map<string, typeof data.workspaces>();
  const queue: typeof data.workspaces = [];
  for (const workspace of data.workspaces) {
    if (workspace.parentWorkspaceId === null) {
      queue.push(workspace);
    } else {
      const siblings = children.get(workspace.parentWorkspaceId) ?? [];
      siblings.push(workspace);
      children.set(workspace.parentWorkspaceId, siblings);
    }
  }
  const workspaces = new Set<string>();
  const ordered: typeof data.workspaces = [];
  // Each row is queued at most once; missing/cyclic/colliding parents never
  // authorize descendants. The database supports roots and one child level.
  for (const workspace of queue) {
    if (
      workspaces.has(workspace.id) ||
      !projects.has(workspace.projectId) ||
      (await tx.workspace.findUnique({ where: { id: workspace.id } }))
    ) {
      continue;
    }
    workspaces.add(workspace.id);
    ordered.push(workspace);
    if (workspace.parentWorkspaceId === null) {
      for (const child of children.get(workspace.id) ?? []) {
        queue.push(child);
      }
    }
  }
  return {
    ...data,
    workspaces: ordered,
    agentSessions: data.agentSessions.filter((session) => workspaces.has(session.workspaceId)),
    terminalSessions: data.terminalSessions.filter((session) =>
      workspaces.has(session.workspaceId)
    ),
  };
}
