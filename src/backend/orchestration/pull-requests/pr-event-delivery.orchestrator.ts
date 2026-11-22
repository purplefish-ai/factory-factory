import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import {
  dispatchBackgroundAction,
  type BackgroundAction,
} from '@/backend/orchestration/background-action-dispatch.orchestrator';
import { buildPREventBatch } from '@/backend/prompts/pr-event';
import { createLogger } from '@/backend/services/logger.service';
import type { PRBackgroundDeliveryPort } from '@/backend/services/session';
import { type PRDeliveryRequest } from '@/shared/pr-monitoring';
import { prFactPayloadSchema } from '@/shared/schemas/pr-event.schema';
import { ensureDedicatedPRRecipient } from './pr-dedicated-session.orchestrator';
import { recipientCanDispatch } from './pr-delivery-readiness';
import { isCurrentPRRecipient } from './pr-delivery-recipient';
import { recoverPRDeliveries } from './pr-delivery-recovery';
import type { PRDeliveryPorts } from './pr-monitoring-ports';
import { RATCHET_DISPATCH_CHANGED } from './ratchet.service';

const logger = createLogger('pr-event-delivery');

type DeliveryGuard = 'ready' | 'blocked' | 'discard';
type AuthorizedRecipient = NonNullable<Awaited<ReturnType<typeof readAuthorizedRecipient>>>;

/**
 * Decide once whether `sessionId` may receive `request` now, for every PR in
 * `prIds` (by default the request's own PR). The binding, the recipient and the
 * workspace's sessions are read before the worktree check and again after it;
 * every PR is checked against those reads. The claim transaction rechecks the
 * database state; a prompt in flight, a pending interaction, another session's
 * prompt and the worktree directory are checked only here.
 */
export async function guardPRDelivery(
  sessionId: string,
  request: PRDeliveryRequest,
  services: PRDeliveryPorts,
  prIds: readonly (string | null)[] = [request.prId]
): Promise<DeliveryGuard> {
  const [firstPrId, ...otherPrIds] = [...new Set(prIds)];
  if (!firstPrId || otherPrIds.some((prId) => !prId)) {
    return 'discard';
  }
  const target = { ...request, prId: firstPrId };
  const initial = await readAuthorizedRecipient(sessionId, target, services);
  if (!initial) {
    return 'discard';
  }
  if (
    initial.config.deliveryPauseReason ||
    isRecipientBusy(sessionId, services) ||
    !(await recipientCanDispatch(request.workspaceId, sessionId, services))
  ) {
    return 'blocked';
  }
  if (!(await isPRAttached(request.workspaceId, firstPrId, services))) {
    return 'discard';
  }
  if (
    !(await checkWorktree(sessionId, request, initial.session.workspace.worktreePath, services))
  ) {
    return 'blocked';
  }
  for (const prId of otherPrIds) {
    if (
      !(
        prId &&
        (await isCurrentPRRecipient(initial.config, initial.session, prId, services)) &&
        (await isPRAttached(request.workspaceId, prId, services))
      )
    ) {
      return 'discard';
    }
  }
  return recheckAfterWorktree(sessionId, target, otherPrIds, services);
}

function isRecipientBusy(sessionId: string, services: PRDeliveryPorts) {
  return (
    !!services.sessionDomainService.getPendingInteractiveRequest(sessionId) ||
    services.acpRuntimeManager.isSessionPromptInFlight(sessionId)
  );
}

async function isPRAttached(workspaceId: string, prId: string, services: PRDeliveryPorts) {
  return !!(await services.workspacePrSnapshotService.find({ workspaceId, prId }));
}

/** False when the worktree is missing (and delivery is then paused) or cannot be checked. */
async function checkWorktree(
  sessionId: string,
  request: PRDeliveryRequest,
  worktreePath: string | null,
  services: PRDeliveryPorts
) {
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
    return false;
  }
  if (!worktreeAvailable) {
    const paused = await services.workspacePRMonitoringService.pauseWorkspace(
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
    return false;
  }
  return true;
}

/** The checks repeated after the asynchronous worktree check and any pause it wrote. */
async function recheckAfterWorktree(
  sessionId: string,
  target: PRDeliveryRequest,
  otherPrIds: (string | null)[],
  services: PRDeliveryPorts
): Promise<DeliveryGuard> {
  const othersIdle = await recipientCanDispatch(target.workspaceId, sessionId, services);
  const final = await readAuthorizedRecipient(sessionId, target, services);
  if (!(final && (await isRecipientForEvery(final, otherPrIds, services)))) {
    return 'discard';
  }
  const config = await readBindingAfterRecipientLookup(final.config, target, services);
  if (!config) {
    return 'discard';
  }
  if (!othersIdle || config.deliveryPauseReason || isRecipientBusy(sessionId, services)) {
    return 'blocked';
  }
  return 'ready';
}

/**
 * A DEDICATED recipient check awaits the dedicated-conversation lookup, so the
 * binding read before it may be stale; read it again. A MAIN check awaits
 * nothing, so its binding read is still the latest. After `validate` there is
 * no claim transaction left to catch a stale binding.
 */
async function readBindingAfterRecipientLookup(
  config: NonNullable<MonitoringConfig>,
  request: PRDeliveryRequest,
  services: PRDeliveryPorts
) {
  if ((config.deliveryMode ?? 'MAIN') === 'MAIN') {
    return config;
  }
  const latest = await services.workspacePRMonitoringService.get(request.workspaceId);
  return matchesBinding(latest, request) ? latest : null;
}

async function isRecipientForEvery(
  recipient: AuthorizedRecipient,
  prIds: (string | null)[],
  services: PRDeliveryPorts
) {
  for (const prId of prIds) {
    if (!(await isCurrentPRRecipient(recipient.config, recipient.session, prId, services))) {
      return false;
    }
  }
  return true;
}

export async function preparePRDelivery(
  {
    sessionId,
    request,
  }: {
    sessionId: string;
    request: PRDeliveryRequest;
  },
  services: PRDeliveryPorts
): ReturnType<PRBackgroundDeliveryPort['prepare']> {
  const initialGuard = await guardPRDelivery(sessionId, request, services);
  if (initialGuard !== 'ready') {
    return blockedGuardResult(initialGuard);
  }
  const main = (request.deliveryMode ?? 'MAIN') === 'MAIN';
  const candidates = await readDeliveryCandidates(request, main, services);
  // The guard after the refresh still runs before every early return and every
  // write below. When there is none, only reads and pure steps separate it from
  // the guard before the claim, so the two are evaluated once, together.
  const afterRefresh = deferGuard(() => guardPRDelivery(sessionId, request, services));
  if (candidates.status !== 'ready') {
    return afterGuard(afterRefresh, () => candidates);
  }
  return prepareCandidateBatch(sessionId, request, main, candidates.events, afterRefresh, services);
}

async function prepareCandidateBatch(
  sessionId: string,
  request: PRDeliveryRequest,
  main: boolean,
  events: PendingPREvent[],
  afterRefresh: DeferredGuard,
  services: PRDeliveryPorts
): ReturnType<PRBackgroundDeliveryPort['prepare']> {
  const first = events[0];
  if (!first) {
    return afterGuard(afterRefresh, () => ({ status: 'discard' }));
  }
  if (events.some((e) => e.deliverySessionId && e.deliverySessionId !== sessionId)) {
    return afterGuard(afterRefresh, () => ({
      status: 'blocked',
      reason: 'Previous recipient delivery needs receipt recovery',
    }));
  }
  if (!(await frozenRetryMatches(first, sessionId, services))) {
    return afterGuard(afterRefresh, () => pauseFrozenRetry(request, services));
  }
  if (events.some((e) => e.attempts >= 3)) {
    return afterGuard(afterRefresh, () => pauseExhaustedDelivery(request, services));
  }
  const rendered = await renderDeliveryBatch(first, events, request, services);
  if (rendered.undeliverable.length) {
    const guard = await afterRefresh.evaluate();
    if (guard !== 'ready') {
      return blockedGuardResult(guard);
    }
    await cancelUndeliverable(request, rendered.undeliverable, rendered.renderError, services);
  }
  const batch = rendered.batch;
  if (!batch) {
    // Nothing deliverable was left this time; the next wake queues what remains.
    return afterGuard(afterRefresh, () => ({ status: 'discard' }));
  }
  const batchPrIds = batch.events.map((event) => event.prId);
  const finalGuard = await guardPRDelivery(
    sessionId,
    request,
    services,
    afterRefresh.evaluated ? batchPrIds : [request.prId, ...batchPrIds]
  );
  if (finalGuard !== 'ready') {
    return blockedGuardResult(finalGuard);
  }
  return claimDeliveryOrWait(sessionId, request, main, batch, services);
}

type DeferredGuard = { evaluate: () => Promise<DeliveryGuard>; readonly evaluated: boolean };
function deferGuard(evaluate: () => Promise<DeliveryGuard>): DeferredGuard {
  let result: Promise<DeliveryGuard> | undefined;
  return {
    evaluate: () => {
      result ??= evaluate();
      return result;
    },
    get evaluated() {
      return result !== undefined;
    },
  };
}
async function afterGuard(
  guard: DeferredGuard,
  proceed: () => PreparedDelivery | Promise<PreparedDelivery>
): Promise<PreparedDelivery> {
  const result = await guard.evaluate();
  return result === 'ready' ? proceed() : blockedGuardResult(result);
}
type PreparedDelivery = Awaited<ReturnType<PRBackgroundDeliveryPort['prepare']>>;
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
/**
 * Render the batch to freeze, without writing. A stored fact that cannot be
 * parsed or rendered is returned as undeliverable for the caller to discard, so
 * one bad row never holds back the facts queued behind it.
 */
async function renderDeliveryBatch(
  first: PendingPREvent,
  events: PendingPREvent[],
  request: PRDeliveryRequest,
  services: PRDeliveryPorts
): Promise<{
  batch: { deliveryId: string; text: string; events: PendingPREvent[] } | null;
  undeliverable: PendingPREvent[];
  renderError?: unknown;
}> {
  const settings = await services.userSettingsService.get();
  const deliveryId = first.deliveryId ?? randomUUID();
  if (first.deliveryText !== null && first.deliveryText !== undefined) {
    return { batch: { deliveryId, text: first.deliveryText, events }, undeliverable: [] };
  }
  const parsed = events.map((event) => ({
    event,
    payload: prFactPayloadSchema.safeParse(event.payload),
  }));
  const facts = parsed.flatMap(({ event, payload }) =>
    payload.success ? [{ event, payload: payload.data }] : []
  );
  const undeliverable = parsed.flatMap(({ event, payload }) => (payload.success ? [] : [event]));
  let batch: ReturnType<typeof buildPREventBatch> | null = null;
  let renderError: unknown;
  try {
    batch = facts.length
      ? buildPREventBatch({
          deliveryId,
          events: facts.map((fact) => fact.payload),
          replyToPrComments: settings.ratchetReplyToPrComments,
          deliveryMode: request.deliveryMode,
        })
      : null;
  } catch (error) {
    // Rendering fails only on the batch's first PR, whose section must always fit.
    renderError = error;
    undeliverable.push(
      ...facts.filter((fact) => fact.event.prId === facts[0]?.event.prId).map((fact) => fact.event)
    );
  }
  const errorField = renderError === undefined ? {} : { renderError };
  if (!batch) {
    return { batch: null, undeliverable, ...errorField };
  }
  const prIds = batch.prIds;
  return {
    batch: {
      deliveryId,
      text: batch.text,
      events: facts.flatMap(({ event }) =>
        event.prId && prIds.includes(event.prId) ? [event] : []
      ),
    },
    undeliverable,
    ...errorField,
  };
}

async function cancelUndeliverable(
  request: PRDeliveryRequest,
  undeliverable: PendingPREvent[],
  renderError: unknown,
  services: PRDeliveryPorts
) {
  const eventIds = undeliverable.map((event) => event.id);
  await services.workspacePRMonitoringService.cancelUndeliverable(request.workspaceId, eventIds);
  logger.error('Discarded stored PR facts that cannot be delivered', {
    workspaceId: request.workspaceId,
    eventIds,
    ...(renderError === undefined ? {} : { error: renderError }),
  });
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
  services: PRDeliveryPorts,
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
  const deliveries: Extract<BackgroundAction, { target: 'existing_sessions' }>['deliveries'] = [];
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
    deliveries.push({
      sessionId: recipient,
      request: {
        workspaceId,
        prId,
        bindingRevision: revision,
        ...(mode === 'DEDICATED' ? { deliveryMode: mode } : {}),
      },
    });
  }
  await dispatchBackgroundAction(
    { target: 'existing_sessions', deliveries },
    services.backgroundDispatch
  );
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
async function frozenRetryMatches(
  event: PendingPREvent,
  sessionId: string,
  services: PRDeliveryPorts
) {
  if (!event.deliveryId) {
    return true;
  }
  const session = await services.sessionDataService.findAgentSessionById(sessionId);
  return !!(
    session &&
    event.deliveryProviderSessionId &&
    event.deliveryProvider === session.provider &&
    event.deliveryProviderSessionId === session.providerSessionId
  );
}
async function pauseFrozenRetry(
  request: PRDeliveryRequest,
  services: PRDeliveryPorts
): Promise<PreparedDelivery> {
  await services.workspacePRMonitoringService.pauseWorkspace(
    request.workspaceId,
    'RECEIPT_UNAVAILABLE',
    request.bindingRevision
  );
  return {
    status: 'blocked',
    reason: 'Frozen PR update belongs to a different or unknown conversation',
  };
}
type PendingPREvent = Awaited<
  ReturnType<PRDeliveryPorts['workspacePRMonitoringService']['listPending']>
>[number];
async function pauseExhaustedDelivery(
  request: PRDeliveryRequest,
  services: PRDeliveryPorts
): Promise<PreparedDelivery> {
  await services.workspacePRMonitoringService.pauseWorkspace(
    request.workspaceId,
    'DELIVERY_FAILED',
    request.bindingRevision
  );
  return { status: 'blocked', reason: 'PR update transport failed three times' };
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
