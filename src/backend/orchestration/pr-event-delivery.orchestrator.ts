import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { buildPREventBatch } from '@/backend/prompts/pr-event';
import { createLogger } from '@/backend/services/logger.service';
import { RATCHET_DISPATCH_CHANGED } from '@/backend/services/ratchet';
import type { PRBackgroundDeliveryPort } from '@/backend/services/session';
import { type PRDeliveryRequest } from '@/shared/pr-monitoring';
import { prFactPayloadSchema } from '@/shared/schemas/pr-event.schema';
import { ensureDedicatedPRRecipient } from './pr-dedicated-session.orchestrator';
import { defaultPRDeliveryPorts } from './pr-delivery-dependencies';
import { recipientCanDispatch } from './pr-delivery-readiness';
import { isCurrentPRRecipient } from './pr-delivery-recipient';
import { recoverPRDeliveries } from './pr-delivery-recovery';
import type { PRDeliveryPorts } from './pr-monitoring-ports';

const logger = createLogger('pr-event-delivery');

export async function guardPRDelivery(
  sessionId: string,
  request: PRDeliveryRequest,
  services: PRDeliveryPorts
) {
  if (!request.prId) {
    return 'discard';
  }
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
    acpRuntimeManager.isSessionPromptInFlight(sessionId) ||
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
  const worktreePath = initial.session.workspace.worktreePath;
  const worktreeAvailable = worktreePath
    ? await stat(worktreePath).then(
        (info) => info.isDirectory(),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTDIR')
            ? false
            : null
      )
    : false;
  if (worktreeAvailable === null) {
    return 'blocked';
  }
  if (!worktreeAvailable) {
    const paused = await workspacePRMonitoringService.pauseWorkspace(
      request.workspaceId,
      'SESSION_FAILED',
      request.bindingRevision
    );
    if (paused.count) {
      services.sessionBackgroundDeliveryService.invalidate(
        request.workspaceId,
        request.bindingRevision
      );
      services.ratchetService.emit(RATCHET_DISPATCH_CHANGED, { workspaceId: request.workspaceId });
      logger.warn('PR delivery paused because the workspace worktree is unavailable', {
        workspaceId: request.workspaceId,
        sessionId,
        worktreePath,
      });
    }
    return 'blocked';
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
    acpRuntimeManager.isSessionPromptInFlight(sessionId)
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
  services: PRDeliveryPorts = defaultPRDeliveryPorts
): ReturnType<PRBackgroundDeliveryPort['prepare']> {
  const initialGuard = await guardPRDelivery(sessionId, request, services);
  if (initialGuard !== 'ready') {
    return blockedGuardResult(initialGuard);
  }
  const main = (request.deliveryMode ?? 'MAIN') === 'MAIN';
  const candidates = await readDeliveryCandidates(request, main, services);
  const finalGuard = await guardPRDelivery(sessionId, request, services);
  if (finalGuard !== 'ready') {
    return blockedGuardResult(finalGuard);
  }
  if (candidates.status !== 'ready') {
    return candidates;
  }
  const events = candidates.events;
  const first = events[0];
  if (!first) {
    return { status: 'discard' };
  }
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
  const batch = await buildDeliveryBatch(first, events, request, services);
  if (!batch) {
    return { status: 'blocked', reason: 'Stored PR update is invalid' };
  }
  const targetGuard = await guardDeliveryTargets(sessionId, request, batch.events, services);
  if (targetGuard !== 'ready') {
    return blockedGuardResult(targetGuard);
  }
  return claimDeliveryOrWait(sessionId, request, main, batch, services);
}
async function readDeliveryCandidates(
  request: PRDeliveryRequest,
  main: boolean,
  services: PRDeliveryPorts
) {
  const monitoring = services.workspacePRMonitoringService;
  const pending = (
    await monitoring.listPending(request.workspaceId, main ? undefined : request.prId)
  ).filter((event) => event.prId !== null);
  const first = pending[0];
  if (!first) {
    return { status: 'discard' as const };
  }
  if (first.state === 'DISPATCHING') {
    return { status: 'blocked' as const, reason: 'Waiting for delivery receipt' };
  }
  const events = selectDeliveryEvents(pending, first);
  if (first.deliveryId) {
    return { status: 'ready' as const, events };
  }
  const refreshed = await refreshDeliveryObservations(request, events, services);
  const latest = (
    await monitoring.listPending(request.workspaceId, main ? undefined : request.prId)
  ).filter((event) => event.prId !== null);
  if (!latest.length) {
    return { status: 'discard' as const };
  }
  const eligible = latest.filter(
    (event) =>
      event.prId && refreshed.has(event.prId) && event.state === 'PENDING' && !event.deliveryId
  );
  return eligible.length
    ? { status: 'ready' as const, events: eligible }
    : { status: 'blocked' as const, reason: 'Waiting for fresh PR observations' };
}
async function refreshDeliveryObservations(
  request: PRDeliveryRequest,
  events: PendingPREvent[],
  services: PRDeliveryPorts
) {
  const targets = [...new Set(events.flatMap((event) => (event.prId ? [event.prId] : [])))];
  const refreshed = new Set<string>();
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const prId = targets[next++];
      if (!prId) {
        return;
      }
      const target = { workspaceId: request.workspaceId, prId };
      try {
        if (
          (await services.workspacePrSnapshotService.find(target)) &&
          (await services.refreshObservation(target))
        ) {
          refreshed.add(prId);
        }
      } catch (error) {
        logger.warn('PR delivery observation refresh deferred', { ...target, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, targets.length) }, () => worker()));
  return refreshed;
}
async function buildDeliveryBatch(
  first: PendingPREvent,
  events: PendingPREvent[],
  request: PRDeliveryRequest,
  services: PRDeliveryPorts
) {
  const settings = await services.userSettingsService.get();
  const deliveryId = first.deliveryId ?? randomUUID();
  try {
    if (first.deliveryText !== null && first.deliveryText !== undefined) {
      return { deliveryId, text: first.deliveryText, events };
    }
    const batch = buildPREventBatch({
      deliveryId,
      events: events.map((event) => prFactPayloadSchema.parse(event.payload)),
      replyToPrComments: settings.ratchetReplyToPrComments,
      deliveryMode: request.deliveryMode,
    });
    return {
      deliveryId,
      text: batch.text,
      events: events.filter((event) => event.prId && batch.prIds.includes(event.prId)),
    };
  } catch (error) {
    await services.workspacePRMonitoringService.pauseWorkspace(
      request.workspaceId,
      'INVALID_EVENT',
      request.bindingRevision
    );
    logger.error('Invalid persisted PR event', { error });
    return null;
  }
}

async function guardDeliveryTargets(
  sessionId: string,
  request: PRDeliveryRequest,
  events: PendingPREvent[],
  services: PRDeliveryPorts
) {
  for (const prId of new Set(events.map((e) => e.prId))) {
    const guard = await guardPRDelivery(sessionId, { ...request, prId }, services);
    if (guard !== 'ready') {
      return guard;
    }
  }
  return 'ready' as const;
}
async function claimDeliveryOrWait(
  sessionId: string,
  request: PRDeliveryRequest,
  main: boolean,
  batch: { deliveryId: string; text: string; events: PendingPREvent[] },
  services: PRDeliveryPorts
): ReturnType<PRBackgroundDeliveryPort['prepare']> {
  const monitoring = services.workspacePRMonitoringService;
  const delivery = await monitoring.claimDelivery(
    { ...request, prId: main ? null : request.prId },
    {
      deliveryId: batch.deliveryId,
      sessionId,
      eventIds: batch.events.map((event) => event.id),
      text: batch.text,
    }
  );
  if (delivery) {
    return { status: 'ready', delivery };
  }
  const remaining = await monitoring.listPending(
    request.workspaceId,
    main ? undefined : request.prId
  );
  const guard = await guardPRDelivery(sessionId, request, services);
  return remaining.length && guard !== 'discard'
    ? { status: 'blocked', reason: 'Waiting for the workspace PR delivery claim' }
    : { status: 'discard' };
}

type MonitoringConfig = Awaited<ReturnType<PRDeliveryPorts['workspacePRMonitoringService']['get']>>;
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
  services: PRDeliveryPorts
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
  services: PRDeliveryPorts = defaultPRDeliveryPorts,
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
  services: PRDeliveryPorts,
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
    // Older databases may retain workspace-level enablement controls.
    if (!prId) {
      continue;
    }
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
    void services.sessionDispatchService
      .tryDispatchNextMessage(sessionId)
      .catch((error) => logger.warn('PR queue dispatch deferred', { workspaceId, error }));
  }
}
async function resolveRecipient(
  workspaceId: string,
  prId: string | null,
  config: NonNullable<MonitoringConfig>,
  services: PRDeliveryPorts,
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
  services: PRDeliveryPorts
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
  ReturnType<PRDeliveryPorts['workspacePRMonitoringService']['listPending']>
>[number];
async function pauseExhaustedDelivery(
  events: { attempts: number }[],
  request: PRDeliveryRequest,
  services: PRDeliveryPorts
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
  pending: Awaited<ReturnType<PRDeliveryPorts['workspacePRMonitoringService']['listPending']>>,
  first: Awaited<ReturnType<PRDeliveryPorts['workspacePRMonitoringService']['listPending']>>[number]
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
