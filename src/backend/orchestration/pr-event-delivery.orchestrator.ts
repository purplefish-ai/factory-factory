import { randomUUID } from 'node:crypto';
import { buildPREventMessage } from '@/backend/prompts/pr-event';
import { createLogger } from '@/backend/services/logger.service';
import { RATCHET_DISPATCH_CHANGED, ratchetService } from '@/backend/services/ratchet';
import {
  acpRuntimeManager,
  chatMessageHandlerService,
  findPRDeliveryReceipt,
  type PRBackgroundDeliveryPort,
  sessionBackgroundDeliveryService,
  sessionDataService,
  sessionDomainService,
} from '@/backend/services/session';
import { userSettingsService } from '@/backend/services/settings';
import {
  workspacePRMonitoringService,
  workspacePrSnapshotService,
} from '@/backend/services/workspace';
import {
  type ClaimedPRDelivery,
  isPRMonitoringRecipient,
  type PRDeliveryRequest,
} from '@/shared/pr-monitoring';
import { prMonitoringEventPayloadSchema } from '@/shared/schemas/pr-event.schema';
import { observeMonitoredPR, recipientCanDispatch } from './pr-observation.orchestrator';

const logger = createLogger('pr-event-delivery');

async function guard(sessionId: string, request: PRDeliveryRequest) {
  const [config, session] = await Promise.all([
    workspacePRMonitoringService.get(request.workspaceId),
    sessionDataService.findAgentSessionById(sessionId),
  ]);
  if (
    !config?.enabled ||
    config.recipientSessionId !== sessionId ||
    config.bindingRevision !== request.bindingRevision ||
    !session ||
    session.workspaceId !== request.workspaceId ||
    !isPRMonitoringRecipient(session) ||
    session.workspace.status !== 'READY'
  ) {
    return 'discard';
  }
  if (
    config.deliveryPauseReason ||
    sessionDomainService.getPendingInteractiveRequest(sessionId) ||
    acpRuntimeManager.isSessionWorking(sessionId) ||
    !(await recipientCanDispatch(request.workspaceId, sessionId))
  ) {
    return 'blocked';
  }
  if (
    request.prId &&
    !(await workspacePrSnapshotService.find({
      workspaceId: request.workspaceId,
      prId: request.prId,
    }))
  ) {
    return 'discard';
  }
  const [finalConfig, finalSession] = await Promise.all([
    workspacePRMonitoringService.get(request.workspaceId),
    sessionDataService.findAgentSessionById(sessionId),
  ]);
  if (
    !finalConfig?.enabled ||
    finalConfig.bindingRevision !== request.bindingRevision ||
    finalConfig.recipientSessionId !== sessionId ||
    finalSession?.workspace.status !== 'READY'
  ) {
    return 'discard';
  }
  if (
    finalConfig.deliveryPauseReason ||
    sessionDomainService.getPendingInteractiveRequest(sessionId) ||
    acpRuntimeManager.isSessionWorking(sessionId)
  ) {
    return 'blocked';
  }
  return 'ready';
}
export async function preparePRDelivery({
  sessionId,
  request,
}: {
  sessionId: string;
  request: PRDeliveryRequest;
}): ReturnType<PRBackgroundDeliveryPort['prepare']> {
  const initialGuard = await guard(sessionId, request);
  if (initialGuard !== 'ready') {
    return initialGuard === 'discard'
      ? { status: 'discard' }
      : { status: 'blocked', reason: 'Recipient is paused or busy' };
  }
  if (request.prId) {
    await observeMonitoredPR({ workspaceId: request.workspaceId, prId: request.prId });
  }
  const finalGuard = await guard(sessionId, request);
  if (finalGuard !== 'ready') {
    return finalGuard === 'discard'
      ? { status: 'discard' }
      : { status: 'blocked', reason: 'Recipient is paused or busy' };
  }
  const pending = await workspacePRMonitoringService.listPending(request.workspaceId, request.prId);
  const first = pending[0];
  if (!first) {
    return { status: 'discard' };
  }
  if (first.state === 'DISPATCHING') {
    return { status: 'blocked', reason: 'Waiting for delivery receipt' };
  }
  const events = selectDeliveryEvents(pending, first);
  if (events.some((e) => e.deliverySessionId && e.deliverySessionId !== sessionId)) {
    return { status: 'blocked', reason: 'Previous recipient delivery needs receipt recovery' };
  }
  if (await pauseExhaustedDelivery(events, request)) {
    return { status: 'blocked', reason: 'PR update transport failed three times' };
  }
  const settings = await userSettingsService.get();
  const deliveryId = first.deliveryId ?? randomUUID();
  let text: string;
  try {
    text =
      first.deliveryText ??
      buildPREventMessage({
        deliveryId,
        events: events.map((e) => prMonitoringEventPayloadSchema.parse(e.payload)),
        replyToPrComments: settings.ratchetReplyToPrComments,
      });
  } catch (error) {
    await workspacePRMonitoringService.pauseWorkspace(
      request.workspaceId,
      'INVALID_EVENT',
      request.bindingRevision
    );
    logger.error('Invalid persisted PR event', { error });
    return { status: 'blocked', reason: 'Stored PR update is invalid' };
  }
  const delivery = await workspacePRMonitoringService.claimDelivery(request, {
    deliveryId,
    sessionId,
    eventIds: events.map((e) => e.id),
    text,
  });
  return delivery ? { status: 'ready', delivery } : { status: 'discard' };
}
export async function wakePRDelivery(workspaceId: string): Promise<void> {
  let config = await workspacePRMonitoringService.get(workspaceId);
  if (!(config?.enabled && config.recipientSessionId) || config.deliveryPauseReason) {
    return;
  }
  const previousClaims = await workspacePRMonitoringService.listPending(workspaceId);
  for (const sessionId of new Set(
    previousClaims.map((e) => e.deliverySessionId).filter((id): id is string => !!id)
  )) {
    await recoverPRDeliveries(sessionId, workspaceId);
  }
  config = await workspacePRMonitoringService.get(workspaceId);
  if (!(config?.enabled && config.recipientSessionId) || config.deliveryPauseReason) {
    return;
  }
  const pending = await workspacePRMonitoringService.listPending(workspaceId);
  for (const prId of new Set(pending.map((e) => e.prId))) {
    sessionBackgroundDeliveryService.enqueue(config.recipientSessionId, {
      workspaceId,
      prId,
      bindingRevision: config.bindingRevision,
    });
  }
  if (pending.length) {
    void chatMessageHandlerService
      .tryDispatchNextMessage(config.recipientSessionId)
      .catch((error) => logger.warn('PR queue dispatch deferred', { workspaceId, error }));
  }
}
export async function recoverPRDeliveries(sessionId: string, workspaceId?: string) {
  const session = await sessionDataService.findAgentSessionById(sessionId);
  const targetWorkspaceId = session?.workspaceId ?? workspaceId;
  if (!targetWorkspaceId) {
    return;
  }
  const config = await workspacePRMonitoringService.get(targetWorkspaceId);
  const events = await workspacePRMonitoringService.listPending(targetWorkspaceId);
  for (const deliveryId of new Set(
    events.filter((e) => e.deliverySessionId === sessionId && e.deliveryId).map((e) => e.deliveryId)
  )) {
    if (!deliveryId || acpRuntimeManager.isSessionWorking(sessionId)) {
      continue;
    }
    const receipt = await findPRDeliveryReceipt(sessionId, deliveryId);
    if (receipt === 'unavailable') {
      if (config && !config.deliveryPauseReason) {
        await workspacePRMonitoringService.pauseWorkspace(
          targetWorkspaceId,
          'RECEIPT_UNAVAILABLE',
          config.bindingRevision
        );
      }
      continue;
    }
    if (receipt === 'absent' && config?.recipientSessionId !== sessionId) {
      await workspacePRMonitoringService.cancelRecoveredDelivery(deliveryId, sessionId);
      continue;
    }
    await workspacePRMonitoringService.recoverClaim(deliveryId, receipt === 'delivered');
  }
}
export const prBackgroundDeliveryPort: PRBackgroundDeliveryPort = {
  prepare: preparePRDelivery,
  async validate(delivery: ClaimedPRDelivery) {
    const events = await workspacePRMonitoringService.listPending(
      (await sessionDataService.findAgentSessionById(delivery.sessionId))?.workspaceId ?? ''
    );
    const event = events.find((e) => e.deliveryId === delivery.deliveryId);
    return (
      !!event &&
      (await guard(delivery.sessionId, {
        workspaceId: event.workspaceId,
        prId: event.prId,
        bindingRevision: delivery.bindingRevision,
      })) === 'ready'
    );
  },
  async complete(delivery) {
    await workspacePRMonitoringService.settleDelivery({ ...delivery, result: 'delivered' });
    const session = await sessionDataService.findAgentSessionById(delivery.sessionId);
    if (session) {
      ratchetService.emit(RATCHET_DISPATCH_CHANGED, { workspaceId: session.workspaceId });
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
      await workspacePRMonitoringService.pauseWorkspace(
        session.workspaceId,
        message.includes('existing conversation') ? 'RESUME_FAILED' : 'DELIVERY_FAILED',
        delivery.bindingRevision
      );
    }
  },
  recover: recoverPRDeliveries,
  async pause(sessionId, reason) {
    const session = await sessionDataService.findAgentSessionById(sessionId);
    const config = session ? await workspacePRMonitoringService.get(session.workspaceId) : null;
    await workspacePRMonitoringService.pause(sessionId, reason);
    if (session) {
      ratchetService.emit(RATCHET_DISPATCH_CHANGED, { workspaceId: session.workspaceId });
    }
    if (config) {
      sessionBackgroundDeliveryService.invalidate(config.workspaceId, config.bindingRevision);
    }
  },
  async resume(sessionId) {
    await workspacePRMonitoringService.resume(sessionId);
    const session = await sessionDataService.findAgentSessionById(sessionId);
    if (session) {
      ratchetService.emit(RATCHET_DISPATCH_CHANGED, { workspaceId: session.workspaceId });
    }
  },
};

async function pauseExhaustedDelivery(events: { attempts: number }[], request: PRDeliveryRequest) {
  if (events.some((e) => e.attempts >= 3)) {
    await workspacePRMonitoringService.pauseWorkspace(
      request.workspaceId,
      'DELIVERY_FAILED',
      request.bindingRevision
    );
    return true;
  }
  return false;
}

function selectDeliveryEvents(
  pending: Awaited<ReturnType<typeof workspacePRMonitoringService.listPending>>,
  first: Awaited<ReturnType<typeof workspacePRMonitoringService.listPending>>[number]
) {
  return first.deliveryId
    ? pending.filter((e) => e.deliveryId === first.deliveryId)
    : pending.filter((e) => !e.deliveryId && e.state === 'PENDING');
}
