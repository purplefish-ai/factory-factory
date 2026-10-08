import type { WorkspacePR, WorkspacePRMonitoring } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import { deriveRatchetState, type RatchetState } from '@/shared/core';

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
export function derivePRCollectionState(
  prs: Pick<WorkspacePR, 'state' | 'ciStatus' | 'hasMergeConflict' | 'reviewState'>[],
  enabled = true
): RatchetState {
  const states = prs.map((pr) =>
    deriveRatchetState({
      ratchetEnabled: enabled,
      prState: pr.state,
      prCiStatus: pr.ciStatus,
      prHasMergeConflict: pr.hasMergeConflict,
      prReviewState: pr.reviewState,
    })
  );
  if (states.length && states.every((s) => s === 'MERGED')) {
    return 'MERGED';
  }
  return (
    (['MERGE_CONFLICT', 'CI_FAILED', 'REVIEW_PENDING', 'CI_RUNNING', 'READY'] as const).find((s) =>
      states.includes(s)
    ) ?? 'IDLE'
  );
}
class WorkspaceRatchetAccessor {
  async findSnapshotProjection(workspaceId: string) {
    const row = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        status: true,
        prMonitoring: true,
        prs: { where: { detachedAt: null } },
        _count: { select: { prEvents: { where: { state: { in: ['PENDING', 'DISPATCHING'] } } } } },
      },
    });
    if (!row) {
      return null;
    }
    const { ratchetLastCheckedAt: _checkedAt, ...fields } = flattenWorkspaceRatchet(
      row.prMonitoring,
      row._count.prEvents
    );
    return {
      status: row.status,
      ...fields,
      ratchetState: derivePRCollectionState(row.prs, row.prMonitoring?.enabled ?? false),
      prHasMergeConflict: row.prs.some((pr) => pr.hasMergeConflict),
    };
  }
}
export const workspaceRatchetAccessor = new WorkspaceRatchetAccessor();
