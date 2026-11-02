import type { DataBackupTransactionClient } from '@/backend/services/settings';
import type { ExportData } from '@/shared/schemas/export-data.schema';

/** Existing IDs alone convey no authority to attach an imported descendant. */
export async function selectRecoveryGraph(
  data: ExportData['data'],
  tx: DataBackupTransactionClient,
  projects: ReadonlySet<string>
) {
  const pending = [...data.workspaces];
  const workspaces = new Set<string>();
  const ordered: typeof data.workspaces = [];
  // Topological traversal also rejects cycles and missing parents without looping.
  while (pending.length) {
    let progressed = false;
    for (const workspace of [...pending].reverse()) {
      const index = pending.indexOf(workspace);
      if (workspace.parentWorkspaceId && !workspaces.has(workspace.parentWorkspaceId)) {
        continue;
      }
      pending.splice(index, 1);
      progressed = true;
      if (
        !projects.has(workspace.projectId) ||
        (await tx.workspace.findUnique({ where: { id: workspace.id } }))
      ) {
        continue;
      }
      workspaces.add(workspace.id);
      ordered.push(workspace);
    }
    if (!progressed) {
      break;
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
