import { workspacePrEventAccessor } from '@/backend/services/workspace/resources/workspace-pr-event.accessor';
import { workspacePrMonitoringAccessor } from '@/backend/services/workspace/resources/workspace-pr-monitoring.accessor';
export const workspacePRMonitoringService = {
  cancelRecoveredDelivery:
    workspacePrEventAccessor.cancelRecoveredDelivery.bind(workspacePrEventAccessor),
  addEnabledControl: workspacePrEventAccessor.addEnabledControl.bind(workspacePrEventAccessor),
  deferBusy: workspacePrEventAccessor.deferBusy.bind(workspacePrEventAccessor),
  listConfigs: workspacePrMonitoringAccessor.listConfigs.bind(workspacePrMonitoringAccessor),
  restoreConfigBackup: workspacePrMonitoringAccessor.restoreBackup.bind(
    workspacePrMonitoringAccessor
  ),
  restoreEventsBackup: workspacePrEventAccessor.restoreBackup.bind(workspacePrEventAccessor),
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
