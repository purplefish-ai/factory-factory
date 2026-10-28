import { defaultPRDeliveryPorts } from './pr-delivery-dependencies';
import { isCurrentPRRecipient } from './pr-delivery-recipient';
import type { PRDeliveryRecoveryPorts } from './pr-monitoring-ports';
export async function recoverPRDeliveries(
  sessionId: string,
  workspaceId?: string,
  services: PRDeliveryRecoveryPorts = defaultPRDeliveryPorts
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
    // Fence each lookup against rollovers that happen while provider history is read.
    const receiptSession = await sessionDataService.findAgentSessionById(sessionId);
    const receipt = await findPRDeliveryReceipt(sessionId, deliveryId);
    if (receipt !== 'delivered' && isDeliveryActive(sessionId, deliveryId, services)) {
      continue;
    }
    await settleRecoveredDelivery(
      targetWorkspaceId,
      sessionId,
      deliveryId,
      receipt,
      services,
      receiptSession?.providerSessionId
        ? {
            sessionId,
            provider: receiptSession.provider,
            providerSessionId: receiptSession.providerSessionId,
          }
        : undefined
    );
  }
}
async function settleRecoveredDelivery(
  targetWorkspaceId: string,
  sessionId: string,
  deliveryId: string,
  receipt: Awaited<ReturnType<PRDeliveryRecoveryPorts['findPRDeliveryReceipt']>>,
  services: PRDeliveryRecoveryPorts,
  receiptIdentity: Parameters<
    PRDeliveryRecoveryPorts['workspacePRMonitoringService']['recoverClaim']
  >[2]
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
  if (receipt === 'absent' && receiptIdentity) {
    await recoverAbsentClaim(deliveryId, receiptIdentity, config, services);
    return;
  }
  await workspacePRMonitoringService.recoverClaim(deliveryId, receipt === 'delivered');
}
function isDeliveryActive(
  sessionId: string,
  deliveryId: string,
  services: PRDeliveryRecoveryPorts
) {
  return (
    services.acpRuntimeManager.isSessionPromptInFlight(sessionId) ||
    services.sessionBackgroundDeliveryService.isDeliveryActive?.(deliveryId)
  );
}

async function recoverAbsentClaim(
  deliveryId: string,
  identity: NonNullable<
    Parameters<PRDeliveryRecoveryPorts['workspacePRMonitoringService']['recoverClaim']>[2]
  >,
  config: Awaited<ReturnType<PRDeliveryRecoveryPorts['workspacePRMonitoringService']['get']>>,
  services: PRDeliveryRecoveryPorts
) {
  const recovered = await services.workspacePRMonitoringService.recoverClaim(
    deliveryId,
    false,
    identity
  );
  if (recovered.status === 'identity_mismatch' && config && !config.deliveryPauseReason) {
    await services.workspacePRMonitoringService.pauseWorkspace(
      config.workspaceId,
      'RECEIPT_UNAVAILABLE',
      config.bindingRevision
    );
  }
}
