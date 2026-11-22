import { workspacePrDeliveryAccessor } from '@/backend/services/workspace/resources/workspace-pr-delivery.accessor';
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
  ...input: Parameters<typeof workspacePrDeliveryAccessor.restoreBackup>
) {
  const result = await workspacePrDeliveryAccessor.restoreBackup(...input);
  restartReviewListSlimming();
  return result;
}
export const workspacePRMonitoringService = {
  runEventRetention: runPREventRetention,
  projectEvents: workspacePrEventAccessor.projectEvents,
  exportEvents: workspacePrEventAccessor.exportEvents,
  cancelRecoveredDelivery: workspacePrDeliveryAccessor.cancelRecoveredDelivery.bind(
    workspacePrDeliveryAccessor
  ),
  addEnabledControl: workspacePrEventAccessor.addEnabledControl.bind(workspacePrEventAccessor),
  cancelUndeliverable: workspacePrEventAccessor.cancelUndeliverable.bind(workspacePrEventAccessor),
  deferBusy: workspacePrDeliveryAccessor.deferBusy.bind(workspacePrDeliveryAccessor),
  discardBlockedDeliveries: workspacePrDeliveryAccessor.discardBlockedDeliveries.bind(
    workspacePrDeliveryAccessor
  ),
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
  claimDelivery: workspacePrDeliveryAccessor.claimDelivery.bind(workspacePrDeliveryAccessor),
  settleDelivery: workspacePrDeliveryAccessor.settleDelivery.bind(workspacePrDeliveryAccessor),
  recoverClaim: workspacePrDeliveryAccessor.recoverClaim.bind(workspacePrDeliveryAccessor),
};
