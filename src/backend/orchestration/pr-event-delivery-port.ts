import { createLogger } from '@/backend/services/logger.service';
import { RATCHET_DISPATCH_CHANGED } from '@/backend/services/ratchet';
import type { PRBackgroundDeliveryPort } from '@/backend/services/session';
import type { ClaimedPRDelivery } from '@/shared/pr-monitoring';
import { isCurrentPRRecipient } from './pr-delivery-recipient';
import { recoverPRDeliveries } from './pr-delivery-recovery';
import {
  preparePRDelivery,
  guardPRDelivery,
  wakePRDelivery,
} from './pr-event-delivery.orchestrator';
import {
  defaultPRMonitoringServices,
  type PRMonitoringServices,
} from './pr-monitoring-dependencies';
const logger = createLogger('pr-event-delivery-port');
export function createPRBackgroundDeliveryPort(
  services: PRMonitoringServices
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
      const event = events.find((e) => e.deliveryId === delivery.deliveryId);
      return (
        !!event &&
        (await guardPRDelivery(
          delivery.sessionId,
          {
            workspaceId: event.workspaceId,
            prId: event.prId,
            bindingRevision: delivery.bindingRevision,
            deliveryMode: config?.deliveryMode,
          },
          services
        )) === 'ready'
      );
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
    async fail(delivery, error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('A turn is already in progress') ||
        message.includes('human message queued during preparation')
      ) {
        await workspacePRMonitoringService.deferBusy(delivery.deliveryId);
        return;
      }
      await workspacePRMonitoringService.settleDelivery({ ...delivery, result: 'retry' });
      const session = await sessionDataService.findAgentSessionById(delivery.sessionId);
      if (session && (delivery.attempt >= 3 || message.includes('existing conversation'))) {
        const paused = await workspacePRMonitoringService.pauseWorkspace(
          session.workspaceId,
          message.includes('existing conversation') ? 'RESUME_FAILED' : 'DELIVERY_FAILED',
          delivery.bindingRevision
        );
        if (paused.count) {
          ratchetService.emit(RATCHET_DISPATCH_CHANGED, { workspaceId: session.workspaceId });
        }
      }
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
export const prBackgroundDeliveryPort = createPRBackgroundDeliveryPort(defaultPRMonitoringServices);

async function invalidateRecipient(
  config: Awaited<ReturnType<PRMonitoringServices['workspacePRMonitoringService']['get']>>,
  session: Awaited<ReturnType<PRMonitoringServices['sessionDataService']['findAgentSessionById']>>,
  services: PRMonitoringServices
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
