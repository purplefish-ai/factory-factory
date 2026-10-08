import type { DataBackupTransactionClient, WorkspaceForExport } from '@/backend/services/settings';
import { workspacePRMonitoringService } from '@/backend/services/workspace';
import type { ExportData } from '@/shared/schemas/export-data.schema';
import {
  prAssociationBackupSchema,
  prDiscoveryBackupSchema,
  prEventBackupSchema,
  prMonitoringBackupSchema,
} from '@/shared/schemas/pr-monitoring-backup.schema';

function iso(date: Date | null): string | null {
  return date?.toISOString() ?? null;
}
export function exportPRBackupState(workspace: WorkspaceForExport) {
  return {
    prs: workspace.prs.map(({ workspaceId: _workspaceId, ...pr }) =>
      prAssociationBackupSchema.parse({
        ...pr,
        syncedAt: iso(pr.syncedAt),
        detachedAt: iso(pr.detachedAt),
        ciFailedAt: iso(pr.ciFailedAt),
        ciLastNotifiedAt: iso(pr.ciLastNotifiedAt),
        reviewLastCheckedAt: iso(pr.reviewLastCheckedAt),
      })
    ),
    prDiscovery: workspace.prDiscovery
      ? prDiscoveryBackupSchema.parse({
          lastCheckedAt: iso(workspace.prDiscovery.lastCheckedAt),
          retryCount: workspace.prDiscovery.retryCount,
          nextCheckAt: iso(workspace.prDiscovery.nextCheckAt),
        })
      : null,
    prMonitoring: workspace.prMonitoring
      ? prMonitoringBackupSchema.parse({
          enabled: workspace.prMonitoring.enabled,
          recipientSessionId: workspace.prMonitoring.recipientSessionId,
          bindingRevision: workspace.prMonitoring.bindingRevision,
          eventEpoch: workspace.prMonitoring.eventEpoch,
          deliveryPauseReason: workspace.prMonitoring.deliveryPauseReason,
          legacySessionIds: workspace.prMonitoring.legacySessionIds,
          lastCheckedAt: iso(workspace.prMonitoring.lastCheckedAt),
        })
      : null,
    prEvents: workspace.prEvents.map((event) =>
      prEventBackupSchema.parse({
        ...event,
        claimedAt: iso(event.claimedAt),
        deliveredAt: iso(event.deliveredAt),
        createdAt: event.createdAt.toISOString(),
      })
    ),
  };
}
export async function restorePRBackupState(
  workspaces: ExportData['data']['workspaces'],
  importedWorkspaceIds: string[],
  tx: DataBackupTransactionClient
) {
  for (const workspace of workspaces) {
    if (!importedWorkspaceIds.includes(workspace.id)) {
      continue;
    }
    const config = workspace.prMonitoring ?? {
      enabled: workspace.ratchetEnabled,
      recipientSessionId: null,
      bindingRevision: 0,
      eventEpoch: workspace.ratchetEnabled ? 1 : 0,
      deliveryPauseReason: workspace.ratchetActiveSessionId ? ('LEGACY_FIXER' as const) : null,
      legacySessionIds: workspace.ratchetActiveSessionId ? [workspace.ratchetActiveSessionId] : [],
      lastCheckedAt: workspace.ratchetLastCheckedAt,
    };
    await workspacePRMonitoringService.restoreConfigBackup(tx, workspace.id, config);
    await workspacePRMonitoringService.restoreEventsBackup(tx, workspace.id, workspace.prEvents);
  }
}
