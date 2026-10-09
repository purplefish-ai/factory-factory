import { randomUUID } from 'node:crypto';
import { buildPREventMessage } from '@/backend/prompts/pr-event';
import { createLogger } from '@/backend/services/logger.service';
import type { PRBackgroundDeliveryPort } from '@/backend/services/session';
import { type PRDeliveryRequest } from '@/shared/pr-monitoring';
import { prMonitoringEventPayloadSchema } from '@/shared/schemas/pr-event.schema';
import { ensureDedicatedPRRecipient } from './pr-dedicated-session.orchestrator';
import { isCurrentPRRecipient } from './pr-delivery-recipient';
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
    sessionDomainService,
    acpRuntimeManager,
    workspacePrSnapshotService,
  } = services;
  const initial = await readAuthorizedRecipient(sessionId, request, services);
  if (!initial) {
    return 'discard';
  }
  const { config } = initial;
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
  const final = await readAuthorizedRecipient(sessionId, request, services);
  if (!final) {
    return 'discard';
  }
  const latestConfig = await workspacePRMonitoringService.get(request.workspaceId);
  if (!matchesBinding(latestConfig, request)) {
    return 'discard';
  }
  if (
    !finalRecipientAllowed ||
    latestConfig.deliveryPauseReason ||
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
        deliveryMode: request.deliveryMode,
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
  if (delivery) {
    return { status: 'ready', delivery };
  }
  const remaining = await workspacePRMonitoringService.listPending(
    request.workspaceId,
    request.prId
  );
  const guard = await guardPRDelivery(sessionId, request, services);
  return remaining.length && guard !== 'discard'
    ? { status: 'blocked', reason: 'Waiting for the workspace PR delivery claim' }
    : { status: 'discard' };
}
type MonitoringConfig = Awaited<
  ReturnType<PRMonitoringServices['workspacePRMonitoringService']['get']>
>;
function matchesBinding(
  config: MonitoringConfig,
  request: PRDeliveryRequest
): config is NonNullable<MonitoringConfig> {
  return (
    !!config?.enabled &&
    config.bindingRevision === request.bindingRevision &&
    (config.deliveryMode ?? 'MAIN') === (request.deliveryMode ?? 'MAIN')
  );
}
async function readAuthorizedRecipient(
  sessionId: string,
  request: PRDeliveryRequest,
  services: PRMonitoringServices
) {
  const [config, session] = await Promise.all([
    services.workspacePRMonitoringService.get(request.workspaceId),
    services.sessionDataService.findAgentSessionById(sessionId),
  ]);
  if (
    !(config && matchesBinding(config, request) && session) ||
    session.workspaceId !== request.workspaceId ||
    session.workspace.status !== 'READY'
  ) {
    return null;
  }
  return (await isCurrentPRRecipient(config, session, request.prId, services))
    ? { config, session }
    : null;
}
function canWake(config: MonitoringConfig) {
  return (
    !!config?.enabled &&
    !config.deliveryPauseReason &&
    ((config.deliveryMode ?? 'MAIN') === 'DEDICATED' || !!config.recipientSessionId)
  );
}
export async function wakePRDelivery(
  workspaceId: string,
  services: PRMonitoringServices = defaultPRMonitoringServices,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const monitoring = services.workspacePRMonitoringService;
  if (!(isCurrent() && canWake(await monitoring.get(workspaceId)))) {
    return;
  }
  const previousClaims = await monitoring.listPending(workspaceId);
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
  const config = await monitoring.get(workspaceId);
  if (!(isCurrent() && config && canWake(config))) {
    return;
  }
  await queueRecipients(workspaceId, config, services, isCurrent);
}
async function queueRecipients(
  workspaceId: string,
  config: NonNullable<MonitoringConfig>,
  services: PRMonitoringServices,
  isCurrent: () => boolean
) {
  const pending = await services.workspacePRMonitoringService.listPending(workspaceId);
  if (!isCurrent()) {
    return;
  }
  const revision = config.bindingRevision;
  const mode = config.deliveryMode ?? 'MAIN';
  const recipients = new Set<string>();
  for (const prId of new Set(pending.map((e) => e.prId))) {
    const recipient = await resolveRecipient(workspaceId, prId, config, services, isCurrent);
    const latest = await services.workspacePRMonitoringService.get(workspaceId);
    if (
      !(
        isCurrent() &&
        canWake(latest) &&
        matchesBinding(latest, { workspaceId, prId, bindingRevision: revision, deliveryMode: mode })
      )
    ) {
      return;
    }
    if (!recipient) {
      continue;
    }
    services.sessionBackgroundDeliveryService.enqueue(recipient, {
      workspaceId,
      prId,
      bindingRevision: revision,
      ...(mode === 'DEDICATED' ? { deliveryMode: mode } : {}),
    });
    recipients.add(recipient);
  }
  for (const sessionId of recipients) {
    void services.chatMessageHandlerService
      .tryDispatchNextMessage(sessionId)
      .catch((error) => logger.warn('PR queue dispatch deferred', { workspaceId, error }));
  }
}
async function resolveRecipient(
  workspaceId: string,
  prId: string | null,
  config: NonNullable<MonitoringConfig>,
  services: PRMonitoringServices,
  isCurrent: () => boolean
) {
  if ((config.deliveryMode ?? 'MAIN') === 'MAIN') {
    return config.recipientSessionId;
  }
  if (!prId) {
    return null;
  }
  const session = await ensureDedicatedPRRecipient(
    { workspaceId, prId, bindingRevision: config.bindingRevision },
    services,
    isCurrent
  );
  return session?.id ?? null;
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
