import { prisma } from '@/backend/db';
import {
  PR_DELIVERY_BLOCKED_PAUSE_REASON,
  prDeliveryModeSchema,
  type PRMonitoringProjection,
} from '@/shared/pr-monitoring';
import type { Prisma, WorkspacePRMonitoring } from '@prisma-gen/client';
import { PR_DELIVERY_STATE, PR_EVENT_STATE } from './workspace-pr-delivery.accessor';
import { projectWorkspacePRCollection } from './workspace-pr.accessor';

/** The legacy toggle name is retained at the API boundary for existing clients. */
export interface WorkspaceRatchetFields {
  ratchetEnabled: boolean;
  ratchetLastCheckedAt: Date | null;
  prMonitoring: PRMonitoringProjection;
}
export type WorkspaceRatchetRow = WorkspacePRMonitoring;
export function flattenWorkspaceRatchet(
  config: WorkspacePRMonitoring | null | undefined,
  pendingEventCount = 0,
  blockedDeliveryCount = 0
): WorkspaceRatchetFields {
  return {
    ratchetEnabled: config?.enabled ?? false,
    ratchetLastCheckedAt: config?.lastCheckedAt ?? null,
    prMonitoring: {
      enabled: config?.enabled ?? false,
      deliveryMode: prDeliveryModeSchema.parse(config?.deliveryMode ?? 'MAIN'),
      recipientSessionId: config?.recipientSessionId ?? null,
      bindingRevision: config?.bindingRevision ?? 0,
      // A persisted pause wins: resuming it then reveals a blocked delivery.
      pauseReason:
        config?.deliveryPauseReason ??
        (config && blockedDeliveryCount > 0 ? PR_DELIVERY_BLOCKED_PAUSE_REASON : null),
      pendingEventCount,
    },
  };
}
export const WORKSPACE_RATCHET_DEFAULTS = flattenWorkspaceRatchet(null);
export const pendingPREventWhere = {
  OR: [
    { batchId: null, state: { in: [PR_EVENT_STATE.PENDING, PR_EVENT_STATE.DISPATCHING] } },
    {
      batch: {
        state: {
          in: [PR_DELIVERY_STATE.PENDING, PR_DELIVERY_STATE.DISPATCHING, PR_DELIVERY_STATE.BLOCKED],
        },
      },
    },
  ],
  prId: { not: null },
  pr: { detachedAt: null },
} satisfies Prisma.WorkspacePREventWhereInput;
/** Counted as `_count.prDeliveries`; any match projects `PR_DELIVERY_BLOCKED_PAUSE_REASON`. */
export const blockedPRDeliveryWhere = {
  state: PR_DELIVERY_STATE.BLOCKED,
} satisfies Prisma.WorkspacePRDeliveryWhereInput;
class WorkspaceRatchetAccessor {
  async findSnapshotProjection(workspaceId: string) {
    const row = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        status: true,
        prMonitoring: true,
        prs: { orderBy: { id: 'asc' } },
        _count: {
          select: {
            prEvents: { where: pendingPREventWhere },
            prDeliveries: { where: blockedPRDeliveryWhere },
          },
        },
      },
    });
    if (!row) {
      return null;
    }
    const { ratchetLastCheckedAt: _checkedAt, ...fields } = flattenWorkspaceRatchet(
      row.prMonitoring,
      row._count.prEvents,
      row._count.prDeliveries
    );
    const {
      prs,
      prCollectionRevision,
      prSummary,
      selectedPrId,
      selectedPr,
      prUrl,
      prNumber,
      prState,
      prCiStatus,
      prUpdatedAt,
      ratchetState,
      prHasMergeConflict,
    } = projectWorkspacePRCollection(row.prs, row.prMonitoring?.enabled ?? false, true);
    return {
      status: row.status,
      ...fields,
      prs,
      prCollectionRevision,
      prSummary,
      selectedPrId,
      selectedPr,
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
