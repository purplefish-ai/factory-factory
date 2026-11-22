import { workspacePrEventAccessor } from '@/backend/services/workspace/resources/workspace-pr-event.accessor';
import { workspacePrMonitoringAccessor } from '@/backend/services/workspace/resources/workspace-pr-monitoring.accessor';
import {
  restartReviewListSlimming,
  runPREventRetention,
} from './workspace-pr-event-retention.service';

/**
 * Restored facts may predate #3288 and carry review lists, so the review-list
 * pass scans again. Queries outside the restore's transaction wait for it, so
 * the rescan sees the rows once they commit; a rollback costs one extra scan.
 */
async function restoreEventsBackup(
  ...input: Parameters<typeof workspacePrEventAccessor.restoreBackup>
) {
  const result = await workspacePrEventAccessor.restoreBackup(...input);
  restartReviewListSlimming();
  return result;
}
export const workspacePRMonitoringService = {
  runEventRetention: runPREventRetention,
  projectEvents: workspacePrEventAccessor.projectEvents,
  exportEvents: workspacePrEventAccessor.exportEvents,
  cancelRecoveredDelivery:
    workspacePrEventAccessor.cancelRecoveredDelivery.bind(workspacePrEventAccessor),
  addEnabledControl: workspacePrEventAccessor.addEnabledControl.bind(workspacePrEventAccessor),
  cancelUndeliverable: workspacePrEventAccessor.cancelUndeliverable.bind(workspacePrEventAccessor),
  deferBusy: workspacePrEventAccessor.deferBusy.bind(workspacePrEventAccessor),
  discardBlockedDeliveries:
    workspacePrEventAccessor.discardBlockedDeliveries.bind(workspacePrEventAccessor),
  listLegacyRetirementCandidates: workspacePrMonitoringAccessor.listLegacyRetirementCandidates.bind(
    workspacePrMonitoringAccessor
  ),
  restoreConfigBackup: workspacePrMonitoringAccessor.restoreBackup.bind(
    workspacePrMonitoringAccessor
  ),
  restoreEventsBackup,
  get: workspacePrMonitoringAccessor.get.bind(workspacePrMonitoringAccessor),
  setBinding: workspacePrMonitoringAccessor.setBinding.bind(workspacePrMonitoringAccessor),
  pause: workspacePrMonitoringAccessor.pause.bind(workspacePrMonitoringAccessor),
  resume: workspacePrMonitoringAccessor.resume.bind(workspacePrMonitoringAccessor),
  pauseWorkspace: workspacePrMonitoringAccessor.pauseWorkspace.bind(workspacePrMonitoringAccessor),
  markChecked: workspacePrMonitoringAccessor.markChecked.bind(workspacePrMonitoringAccessor),
  listEnabled: workspacePrMonitoringAccessor.listEnabled.bind(workspacePrMonitoringAccessor),
  completeLegacyRetirement: workspacePrMonitoringAccessor.completeLegacyRetirement.bind(
    workspacePrMonitoringAccessor
  ),
  listPending: workspacePrEventAccessor.listPending.bind(workspacePrEventAccessor),
  claimDelivery: workspacePrEventAccessor.claimDelivery.bind(workspacePrEventAccessor),
  settleDelivery: workspacePrEventAccessor.settleDelivery.bind(workspacePrEventAccessor),
  recoverClaim: workspacePrEventAccessor.recoverClaim.bind(workspacePrEventAccessor),
};
