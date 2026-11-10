import { createLogger } from '@/backend/services/logger.service';
import type { PRBackgroundDeliveryPort, PRDeliveryFailureReason } from '@/backend/services/session';
import type { ClaimedPRDelivery } from '@/shared/pr-monitoring';
import { isCurrentPRRecipient } from './pr-delivery-recipient';
import { recoverPRDeliveries } from './pr-delivery-recovery';
import {
  preparePRDelivery,
  guardPRDelivery,
  wakePRDelivery,
} from './pr-event-delivery.orchestrator';
import type { PRDeliveryPorts } from './pr-monitoring-ports';
import { RATCHET_DISPATCH_CHANGED } from './ratchet.service';
const logger = createLogger('pr-event-delivery-port');
export function createPRBackgroundDeliveryPort(
  services: PRDeliveryPorts
): PRBackgroundDeliveryPort {
  const { workspacePRMonitoringService, sessionDataService, ratchetService } = services;
  return {
    prepare: (input) => preparePRDelivery(input, services),
    async validate(delivery: ClaimedPRDelivery) {
      const session = await sessionDataService.findAgentSessionById(delivery.sessionId);
      if (
        !(session && delivery.deliveryProviderSessionId) ||
        delivery.deliveryProvider !== session.provider ||
        delivery.deliveryProviderSessionId !== session.providerSessionId
      ) {
        return false;
      }
      const config = await workspacePRMonitoringService.get(session.workspaceId);
      const events = await workspacePRMonitoringService.listPending(session.workspaceId);
      const claimed = events.filter((e) => e.deliveryId === delivery.deliveryId);
      if (
        !claimed.length ||
        new Set(delivery.eventIds).size !== delivery.eventIds.length ||
        claimed.length !== delivery.eventIds.length ||
        claimed.some((event) => !(delivery.eventIds.includes(event.id) && event.prId))
      ) {
        return false;
      }
      for (const prId of new Set(claimed.map((event) => event.prId))) {
        if (
          (await guardPRDelivery(
            delivery.sessionId,
            {
              workspaceId: session.workspaceId,
              prId,
              bindingRevision: delivery.bindingRevision,
              deliveryMode: config?.deliveryMode,
            },
            services
          )) !== 'ready'
        ) {
          return false;
        }
      }
      return true;
    },
    async complete(delivery) {
      await workspacePRMonitoringService.settleDelivery({ ...delivery, result: 'delivered' });
      const session = await sessionDataService.findAgentSessionById(delivery.sessionId);
      if (session) {
        ratchetService.emit(RATCHET_DISPATCH_CHANGED, { workspaceId: session.workspaceId });
        await wakePRDelivery(session.workspaceId, services).catch((error) => {
          logger.warn('PR delivery wake deferred after claim settlement', {
            workspaceId: session.workspaceId,
            error,
          });
        });
      }
    },
    async fail(delivery, { reason }) {
      if (reason === 'busy') {
        await workspacePRMonitoringService.deferBusy(delivery.deliveryId);
        return { paused: false };
      }
      const settled = await workspacePRMonitoringService.settleDelivery({
        ...delivery,
        result: 'retry',
      });
      if (!settled) {
        return { paused: false };
      }
      return pauseAfterFailedDelivery(delivery, reason, services);
    },
    recover: (sessionId) => recoverPRDeliveries(sessionId, undefined, services),
    async pause(sessionId, reason) {
      const session = await sessionDataService.findAgentSessionById(sessionId);
      const config = session ? await workspacePRMonitoringService.get(session.workspaceId) : null;
      await workspacePRMonitoringService.pause(sessionId, reason);
      if (session) {
        ratchetService.emit(RATCHET_DISPATCH_CHANGED, { workspaceId: session.workspaceId });
      }
      await invalidateRecipient(config, session, services);
    },
    async resume(sessionId, isCurrent = () => true) {
      if (!isCurrent()) {
        return;
      }
      const session = await sessionDataService.findAgentSessionById(sessionId);
      if (!isCurrent()) {
        return;
      }
      const previous = session ? await workspacePRMonitoringService.get(session.workspaceId) : null;
      if (!isCurrent()) {
        return;
      }
      await workspacePRMonitoringService.resume(sessionId, isCurrent);
      if (!isCurrent()) {
        return;
      }
      await invalidateRecipient(previous, session, services);
      if (session) {
        ratchetService.emit(RATCHET_DISPATCH_CHANGED, { workspaceId: session.workspaceId });
        await wakePRDelivery(session.workspaceId, services, isCurrent);
      }
    },
  };
}

async function invalidateRecipient(
  config: Awaited<ReturnType<PRDeliveryPorts['workspacePRMonitoringService']['get']>>,
  session: Awaited<ReturnType<PRDeliveryPorts['sessionDataService']['findAgentSessionById']>>,
  services: PRDeliveryPorts
) {
  if (
    config &&
    session &&
    (await isCurrentPRRecipient(config, session, session.workspacePrId ?? null, services))
  ) {
    services.sessionBackgroundDeliveryService.invalidate(
      session.workspaceId,
      config.bindingRevision
    );
  }
}

async function pauseAfterFailedDelivery(
  delivery: ClaimedPRDelivery,
  reason: Exclude<PRDeliveryFailureReason, 'busy'>,
  services: PRDeliveryPorts
): Promise<{ paused: boolean }> {
  const session = await services.sessionDataService.findAgentSessionById(delivery.sessionId);
  if (!(session && (delivery.attempt >= 3 || reason === 'resume_failed'))) {
    return { paused: false };
  }
  const paused = await services.workspacePRMonitoringService.pauseWorkspace(
    session.workspaceId,
    reason === 'resume_failed' ? 'RESUME_FAILED' : 'DELIVERY_FAILED',
    delivery.bindingRevision
  );
  if (paused.count) {
    services.ratchetService.emit(RATCHET_DISPATCH_CHANGED, { workspaceId: session.workspaceId });
  }
  return { paused: paused.count > 0 };
}
