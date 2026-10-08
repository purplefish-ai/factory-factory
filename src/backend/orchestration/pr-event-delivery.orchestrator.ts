import { randomUUID } from 'node:crypto';
import { buildPREventMessage } from '@/backend/prompts/pr-event';
import { createLogger } from '@/backend/services/logger.service';
import type { PRBackgroundDeliveryPort } from '@/backend/services/session';
import { isPRMonitoringRecipient, type PRDeliveryRequest } from '@/shared/pr-monitoring';
import { prMonitoringEventPayloadSchema } from '@/shared/schemas/pr-event.schema';
import { recoverPRDeliveries } from './pr-delivery-recovery';
import {
  defaultPRMonitoringServices,
  type PRMonitoringServices,
} from './pr-monitoring-dependencies';
import { observeMonitoredPR, recipientCanDispatch } from './pr-observation.orchestrator';

const logger = createLogger('pr-event-delivery');

export async function guardPRDelivery(
  sessionId: string,
  request: PRDeliveryRequest,
  services: PRMonitoringServices
) {
  const {
    workspacePRMonitoringService,
    sessionDataService,
    sessionDomainService,
    acpRuntimeManager,
    workspacePrSnapshotService,
  } = services;
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
    !(await recipientCanDispatch(request.workspaceId, sessionId, services))
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
  const finalRecipientAllowed = await recipientCanDispatch(
    request.workspaceId,
    sessionId,
    services
  );
  const [finalConfig, finalSession] = await Promise.all([
    workspacePRMonitoringService.get(request.workspaceId),
    sessionDataService.findAgentSessionById(sessionId),
  ]);
  if (
    !finalConfig?.enabled ||
    finalConfig.bindingRevision !== request.bindingRevision ||
    finalConfig.recipientSessionId !== sessionId ||
    !finalSession ||
    finalSession.workspaceId !== request.workspaceId ||
    !isPRMonitoringRecipient(finalSession) ||
    finalSession.workspace.status !== 'READY'
  ) {
    return 'discard';
  }
  if (
    !finalRecipientAllowed ||
    finalConfig.deliveryPauseReason ||
    sessionDomainService.getPendingInteractiveRequest(sessionId) ||
    acpRuntimeManager.isSessionWorking(sessionId)
  ) {
    return 'blocked';
  }
  return 'ready';
}
export async function preparePRDelivery(
  {
    sessionId,
    request,
  }: {
    sessionId: string;
    request: PRDeliveryRequest;
  },
  services: PRMonitoringServices = defaultPRMonitoringServices
): ReturnType<PRBackgroundDeliveryPort['prepare']> {
  const { workspacePRMonitoringService, userSettingsService } = services;
  const initialGuard = await guardPRDelivery(sessionId, request, services);
  if (initialGuard !== 'ready') {
    return blockedGuardResult(initialGuard);
  }
  if (request.prId) {
    await observeMonitoredPR(
      { workspaceId: request.workspaceId, prId: request.prId },
      undefined,
      { force: true },
      services
    );
  }
  const finalGuard = await guardPRDelivery(sessionId, request, services);
  if (finalGuard !== 'ready') {
    return blockedGuardResult(finalGuard);
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
  if (!(await validateFrozenRetry(first, sessionId, request, services))) {
    return {
      status: 'blocked',
      reason: 'Frozen PR update belongs to a different or unknown conversation',
    };
  }
  if (await pauseExhaustedDelivery(events, request, services)) {
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
export async function wakePRDelivery(
  workspaceId: string,
  services: PRMonitoringServices = defaultPRMonitoringServices,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const {
    workspacePRMonitoringService,
    sessionBackgroundDeliveryService,
    chatMessageHandlerService,
  } = services;
  let config = await workspacePRMonitoringService.get(workspaceId);
  if (
    !(isCurrent() && config?.enabled && config.recipientSessionId) ||
    config.deliveryPauseReason
  ) {
    return;
  }
  const previousClaims = await workspacePRMonitoringService.listPending(workspaceId);
  if (!isCurrent()) {
    return;
  }
  for (const sessionId of new Set(
    previousClaims.map((e) => e.deliverySessionId).filter((id): id is string => !!id)
  )) {
    await recoverPRDeliveries(sessionId, workspaceId, services);
    if (!isCurrent()) {
      return;
    }
  }
  config = await workspacePRMonitoringService.get(workspaceId);
  if (
    !(isCurrent() && config?.enabled && config.recipientSessionId) ||
    config.deliveryPauseReason
  ) {
    return;
  }
  const pending = await workspacePRMonitoringService.listPending(workspaceId);
  if (!isCurrent()) {
    return;
  }
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
async function validateFrozenRetry(
  event: PendingPREvent,
  sessionId: string,
  request: PRDeliveryRequest,
  services: PRMonitoringServices
) {
  if (!event.deliveryId) {
    return true;
  }
  const session = await services.sessionDataService.findAgentSessionById(sessionId);
  if (
    session &&
    event.deliveryProviderSessionId &&
    event.deliveryProvider === session.provider &&
    event.deliveryProviderSessionId === session.providerSessionId
  ) {
    return true;
  }
  await services.workspacePRMonitoringService.pauseWorkspace(
    request.workspaceId,
    'RECEIPT_UNAVAILABLE',
    request.bindingRevision
  );
  return false;
}
type PendingPREvent = Awaited<
  ReturnType<PRMonitoringServices['workspacePRMonitoringService']['listPending']>
>[number];
async function pauseExhaustedDelivery(
  events: { attempts: number }[],
  request: PRDeliveryRequest,
  services: PRMonitoringServices
) {
  const { workspacePRMonitoringService } = services;
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
  pending: Awaited<ReturnType<PRMonitoringServices['workspacePRMonitoringService']['listPending']>>,
  first: Awaited<
    ReturnType<PRMonitoringServices['workspacePRMonitoringService']['listPending']>
  >[number]
) {
  return first.deliveryId
    ? pending.filter((e) => e.deliveryId === first.deliveryId)
    : pending.filter((e) => !e.deliveryId && e.state === 'PENDING');
}

function blockedGuardResult(guard: 'discard' | 'blocked') {
  return guard === 'discard'
    ? { status: 'discard' as const }
    : { status: 'blocked' as const, reason: 'Recipient is paused or busy' };
}
