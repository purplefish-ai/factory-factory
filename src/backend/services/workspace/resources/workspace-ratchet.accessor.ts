import type { Prisma, WorkspacePRMonitoring } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import { projectWorkspacePRCollection } from './workspace-pr.accessor';

/** The legacy toggle name is retained at the API boundary for existing clients. */
export interface WorkspaceRatchetFields {
  ratchetEnabled: boolean;
  ratchetLastCheckedAt: Date | null;
  prMonitoring: {
    enabled: boolean;
    recipientSessionId: string | null;
    bindingRevision: number;
    pauseReason: string | null;
    pendingEventCount: number;
  };
}
export type WorkspaceRatchetRow = WorkspacePRMonitoring;
export function flattenWorkspaceRatchet(
  config: WorkspacePRMonitoring | null | undefined,
  pendingEventCount = 0
): WorkspaceRatchetFields {
  return {
    ratchetEnabled: config?.enabled ?? false,
    ratchetLastCheckedAt: config?.lastCheckedAt ?? null,
    prMonitoring: {
      enabled: config?.enabled ?? false,
      recipientSessionId: config?.recipientSessionId ?? null,
      bindingRevision: config?.bindingRevision ?? 0,
      pauseReason: config?.deliveryPauseReason ?? null,
      pendingEventCount,
    },
  };
}
export const WORKSPACE_RATCHET_DEFAULTS = flattenWorkspaceRatchet(null);
export const pendingPREventWhere = {
  state: { in: ['PENDING', 'DISPATCHING'] },
  OR: [{ prId: null }, { pr: { detachedAt: null } }],
} satisfies Prisma.WorkspacePREventWhereInput;
class WorkspaceRatchetAccessor {
  async findSnapshotProjection(workspaceId: string) {
    const row = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        status: true,
        prMonitoring: true,
        prs: { where: { detachedAt: null } },
        _count: { select: { prEvents: { where: pendingPREventWhere } } },
      },
    });
    if (!row) {
      return null;
    }
    const { ratchetLastCheckedAt: _checkedAt, ...fields } = flattenWorkspaceRatchet(
      row.prMonitoring,
      row._count.prEvents
    );
    const {
      prs,
      prSummary,
      prUrl,
      prNumber,
      prState,
      prCiStatus,
      prUpdatedAt,
      ratchetState,
      prHasMergeConflict,
    } = projectWorkspacePRCollection(row.prs, row.prMonitoring?.enabled ?? false);
    return {
      status: row.status,
      ...fields,
      prs,
      prSummary,
      prUrl,
      prNumber,
      prState,
      prCiStatus,
      prUpdatedAt,
      ratchetState,
      prHasMergeConflict,
    };
  }
}
export const workspaceRatchetAccessor = new WorkspaceRatchetAccessor();
