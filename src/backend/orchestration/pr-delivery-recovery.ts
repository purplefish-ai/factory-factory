import { isCurrentPRRecipient } from './pr-delivery-recipient';
import {
  defaultPRMonitoringServices,
  type PRMonitoringServices,
} from './pr-monitoring-dependencies';
export async function recoverPRDeliveries(
  sessionId: string,
  workspaceId?: string,
  services: PRMonitoringServices = defaultPRMonitoringServices
) {
  const { sessionDataService, workspacePRMonitoringService, findPRDeliveryReceipt } = services;
  const session = await sessionDataService.findAgentSessionById(sessionId);
  const targetWorkspaceId = session?.workspaceId ?? workspaceId;
  if (!targetWorkspaceId) {
    return;
  }
  const events = await workspacePRMonitoringService.listPending(targetWorkspaceId);
  for (const deliveryId of new Set(
    events.filter((e) => e.deliverySessionId === sessionId && e.deliveryId).map((e) => e.deliveryId)
  )) {
    if (!deliveryId || isDeliveryActive(sessionId, deliveryId, services)) {
      continue;
    }
    const receipt = await findPRDeliveryReceipt(sessionId, deliveryId);
    if (receipt !== 'delivered' && isDeliveryActive(sessionId, deliveryId, services)) {
      continue;
    }
    await settleRecoveredDelivery(targetWorkspaceId, sessionId, deliveryId, receipt, services);
  }
}
async function settleRecoveredDelivery(
  targetWorkspaceId: string,
  sessionId: string,
  deliveryId: string,
  receipt: Awaited<ReturnType<PRMonitoringServices['findPRDeliveryReceipt']>>,
  services: PRMonitoringServices
) {
  const { workspacePRMonitoringService } = services;
  const config = await workspacePRMonitoringService.get(targetWorkspaceId);
  if (receipt !== 'delivered' && isDeliveryActive(sessionId, deliveryId, services)) {
    return;
  }
  if (receipt === 'unavailable') {
    if (config && !config.deliveryPauseReason) {
      await workspacePRMonitoringService.pauseWorkspace(
        targetWorkspaceId,
        'RECEIPT_UNAVAILABLE',
        config.bindingRevision
      );
    }
    return;
  }
  const session =
    receipt === 'absent' ? await services.sessionDataService.findAgentSessionById(sessionId) : null;
  const stillBound =
    config &&
    session &&
    (await isCurrentPRRecipient(config, session, session.workspacePrId ?? null, services));
  if (receipt !== 'delivered' && isDeliveryActive(sessionId, deliveryId, services)) {
    return;
  }
  if (receipt === 'absent' && !stillBound) {
    await workspacePRMonitoringService.cancelRecoveredDelivery(deliveryId, sessionId);
    return;
  }
  await workspacePRMonitoringService.recoverClaim(deliveryId, receipt === 'delivered');
}
function isDeliveryActive(sessionId: string, deliveryId: string, services: PRMonitoringServices) {
  return (
    services.acpRuntimeManager.isSessionWorking(sessionId) ||
    services.sessionBackgroundDeliveryService.isDeliveryActive?.(deliveryId)
  );
}
