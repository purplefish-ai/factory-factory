import { retainedReferenceAllowed, type RecoveryImportedIds } from '@/shared/recovery-graph';
import type { ExportData } from '@/shared/schemas/export-data.schema';
import type { Prisma } from '@prisma-gen/client';

/** Retained ownership, never proof that child work stopped. */
export const workspaceChildOriginAccessor = {
  async retain(
    tx: Prisma.TransactionClient,
    workspace: { id: string; parentWorkspaceId: string | null }
  ) {
    if (!workspace.parentWorkspaceId) {
      return;
    }
    const identity = {
      parentWorkspaceId: workspace.parentWorkspaceId,
      childWorkspaceId: workspace.id,
    };
    await tx.workspaceChildOrigin.upsert({
      where: { parentWorkspaceId_childWorkspaceId: identity },
      create: identity,
      update: {},
    });
  },
};

export async function restoreRecoveryChildOrigins(
  tx: Prisma.TransactionClient,
  data: ExportData['data'],
  ids: RecoveryImportedIds
) {
  const sourceWorkspaces = new Set(data.workspaces.map((row) => row.id));
  const incompleteParents = new Set<string>();
  for (const row of data.durable?.workspaceChildOrigin ?? []) {
    const parent = await tx.workspace.findUnique({ where: { id: row.parentWorkspaceId } });
    const child = await tx.workspace.findUnique({ where: { id: row.childWorkspaceId } });
    if (
      !(
        retainedReferenceAllowed(
          sourceWorkspaces,
          ids.workspaces,
          row.parentWorkspaceId,
          !!parent
        ) &&
        retainedReferenceAllowed(sourceWorkspaces, ids.workspaces, row.childWorkspaceId, !!child)
      )
    ) {
      incompleteParents.add(row.parentWorkspaceId);
      continue;
    }
    const existing = await tx.workspaceChildOrigin.findUnique({
      where: {
        parentWorkspaceId_childWorkspaceId: {
          parentWorkspaceId: row.parentWorkspaceId,
          childWorkspaceId: row.childWorkspaceId,
        },
      },
    });
    if (existing && existing.createdAt.toISOString() !== row.createdAt) {
      incompleteParents.add(row.parentWorkspaceId);
      continue;
    }
    await tx.workspaceChildOrigin.upsert({
      where: {
        parentWorkspaceId_childWorkspaceId: {
          parentWorkspaceId: row.parentWorkspaceId,
          childWorkspaceId: row.childWorkspaceId,
        },
      },
      create: row,
      update: {},
    });
  }
  return incompleteParents;
}
