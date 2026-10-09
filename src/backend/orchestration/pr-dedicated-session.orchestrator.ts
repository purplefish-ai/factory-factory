import type { PRMonitoringServices } from '@/backend/orchestration/pr-monitoring-dependencies';
import { recipientCanDispatch } from '@/backend/orchestration/pr-observation.orchestrator';
import { createLogger } from '@/backend/services/logger.service';
import { SessionStartupCancelledError, type AgentSessionRecord } from '@/backend/services/session';
import { PR_DEDICATED_WORKFLOW, type PRTarget } from '@/shared/pr-monitoring';

const logger = createLogger('pr-dedicated-session');
type Target = PRTarget & { bindingRevision: number };
type Bootstrap = { guards: Set<() => boolean>; promise: Promise<AgentSessionRecord | null> };
const bootstrapping = new Map<string, Bootstrap>();
async function current(target: Target, services: PRMonitoringServices, isCurrent: () => boolean) {
  if (!isCurrent()) {
    return false;
  }
  const config = await services.workspacePRMonitoringService.get(target.workspaceId);
  return (
    isCurrent() &&
    !!config?.enabled &&
    config.deliveryMode === 'DEDICATED' &&
    config.bindingRevision === target.bindingRevision &&
    !config.deliveryPauseReason
  );
}
async function acquireForPending(
  target: Target,
  services: PRMonitoringServices,
  isCurrent: () => boolean
): Promise<AgentSessionRecord | null> {
  if (!(await current(target, services, isCurrent))) {
    return null;
  }
  const pending = await services.workspacePRMonitoringService.listPending(target.workspaceId);
  if (
    !(
      (await current(target, services, isCurrent)) &&
      pending.some((event) => event.prId === target.prId && event.state === 'PENDING')
    )
  ) {
    return null;
  }
  if (
    !(
      (await recipientCanDispatch(target.workspaceId, '', services)) &&
      (await current(target, services, isCurrent))
    )
  ) {
    return null;
  }
  const acquired = await services.sessionDataService.acquirePRDedicatedSession({
    workspaceId: target.workspaceId,
    prId: target.prId,
    expectedBindingRevision: target.bindingRevision,
    maxSessions: services.configService.getMaxSessionsPerWorkspace(),
    isCurrent,
  });
  if (!((await current(target, services, isCurrent)) && 'session' in acquired)) {
    return null;
  }
  return acquired.session;
}
async function bootstrapSession(
  target: Target,
  acquired: AgentSessionRecord,
  services: PRMonitoringServices,
  isCurrent: () => boolean
): Promise<AgentSessionRecord | null> {
  const sessionId = acquired.id;
  const resumeCurrent = services.sessionBackgroundDeliveryService.captureResumeGuard(sessionId);
  const valid = () => isCurrent() && resumeCurrent();
  if (
    !(
      (await recipientCanDispatch(target.workspaceId, sessionId, services)) &&
      (await current(target, services, valid))
    )
  ) {
    return null;
  }
  const existing = await services.sessionDataService.findPRDedicatedSession(target);
  if (!((await current(target, services, valid)) && existing) || existing.id !== sessionId) {
    return null;
  }
  if (existing.providerSessionId) {
    return existing;
  }
  try {
    await services.sessionLifecycleService.startSession(sessionId, {
      initialPrompt: '',
      assertCurrent: async () => {
        if (!(await current(target, services, valid))) {
          throw new SessionStartupCancelledError();
        }
      },
    });
  } catch (error) {
    logger.warn('Failed to bootstrap dedicated PR conversation', { ...target, sessionId, error });
    if (await current(target, services, valid)) {
      await services.workspacePRMonitoringService.pauseWorkspace(
        target.workspaceId,
        'RESUME_FAILED',
        target.bindingRevision
      );
    }
    return null;
  }
  if (!(await current(target, services, valid))) {
    return null;
  }
  const started = await services.sessionDataService.findPRDedicatedSession(target);
  if (!(await current(target, services, valid))) {
    return null;
  }
  return started?.id === sessionId &&
    started.providerSessionId &&
    started.workflow === PR_DEDICATED_WORKFLOW
    ? started
    : null;
}
async function resolveRecipient(
  target: Target,
  services: PRMonitoringServices,
  isCurrent: () => boolean
) {
  const acquired = await acquireForPending(target, services, isCurrent);
  if (!(acquired && isCurrent())) {
    return null;
  }
  return acquired.providerSessionId
    ? acquired
    : bootstrapSession(target, acquired, services, isCurrent);
}
export async function ensureDedicatedPRRecipient(
  target: Target,
  services: PRMonitoringServices,
  isCurrent: () => boolean
): Promise<AgentSessionRecord | null> {
  if (!isCurrent()) {
    return null;
  }
  const key = `${target.workspaceId}:${target.prId}:${target.bindingRevision}`;
  let shared = bootstrapping.get(key);
  if (!shared) {
    const guards = new Set([isCurrent]);
    const promise = resolveRecipient(target, services, () => [...guards].some((guard) => guard()))
      .catch((error: unknown) => {
        logger.warn('Failed to acquire dedicated PR conversation', { ...target, error });
        return null;
      })
      .finally(() => {
        if (bootstrapping.get(key)?.promise === promise) {
          bootstrapping.delete(key);
        }
      });
    shared = { guards, promise };
    bootstrapping.set(key, shared);
  } else {
    shared.guards.add(isCurrent);
  }
  try {
    const session = await shared.promise;
    return isCurrent() ? session : null;
  } finally {
    shared.guards.delete(isCurrent);
  }
}
