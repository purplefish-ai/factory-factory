import { codexAccountService } from '@/backend/services/codex-accounts';
import { createLogger } from '@/backend/services/logger.service';
import { sessionLifecycleEventAccessor } from '@/backend/services/session/resources/session-lifecycle-event.accessor';
import {
  acpRuntimeManager,
  fetchClaudeModelCatalogFromAcp,
  fetchCodexModelCatalogFromAppServer,
} from '@/backend/services/session/service/acp';
import { fetchClaudePlanUsage } from '@/backend/services/session/service/acp/claude-plan-usage-loader';
import { closedSessionPersistenceService } from '@/backend/services/session/service/archive/closed-session-persistence.service';
import { SessionConfigService } from '@/backend/services/session/service/config/session.config.service';
import { providerHistoryTranscriptCache } from '@/backend/services/session/service/data/provider-history-transcript-cache';
import { hydrateProviderHistoryIfNeeded } from '@/backend/services/session/service/data/session-provider-history-hydrator';
import { sessionRepository } from '@/backend/services/session/service/data/session.repository';
import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/delivery/session-background-delivery.service';
import { SessionNotificationDeliveryService } from '@/backend/services/session/service/delivery/session-notification-delivery.service';
import {
  EventInitialDispatcher,
  EventInitialDispatchInterrupted,
} from '@/backend/services/session/service/dispatch/event-initial-dispatch';
import { eventSessionAuthority } from '@/backend/services/session/service/event-agent/event-session-authority';
import { AcpEventProcessor } from '@/backend/services/session/service/events/acp-event-processor';
import { SessionPermissionService } from '@/backend/services/session/service/events/session.permission.service';
import { EventOwnedWork } from '@/backend/services/session/service/lifecycle/event-owned-work';
import { SessionLifecycleEventService } from '@/backend/services/session/service/lifecycle/session-lifecycle-event.service';
import {
  sessionAcpEnvironment,
  sessionContextService,
} from '@/backend/services/session/service/lifecycle/session-lifecycle-external-ports';
import { SessionLifecycleGate } from '@/backend/services/session/service/lifecycle/session-lifecycle-gate';
import { SessionProviderIdentityService } from '@/backend/services/session/service/lifecycle/session-provider-identity.service';
import { SessionRuntimeExitCoordinator } from '@/backend/services/session/service/lifecycle/session-runtime-exit.coordinator';
import {
  registerSessionRuntimeParticipants,
  SessionScope,
} from '@/backend/services/session/service/lifecycle/session-scope';
import { SessionStartupCoordinator } from '@/backend/services/session/service/lifecycle/session-startup.coordinator';
import { SessionTerminationCoordinator } from '@/backend/services/session/service/lifecycle/session-termination.coordinator';
import { SessionWorkflowFinalizer } from '@/backend/services/session/service/lifecycle/session-workflow-finalizer';
import { SessionLifecycleService } from '@/backend/services/session/service/lifecycle/session.lifecycle.service';
import { SessionPromptTurnCompletionService } from '@/backend/services/session/service/lifecycle/session.prompt-turn-completion.service';
import { SessionRetryService } from '@/backend/services/session/service/lifecycle/session.retry.service';
import { SessionService } from '@/backend/services/session/service/prompt/session.service';
import { ClaudeModelCatalogService } from '@/backend/services/session/service/providers/claude-model-catalog.service';
import { CodexModelCatalogService } from '@/backend/services/session/service/providers/codex-model-catalog.service';
import { ProviderUsageService } from '@/backend/services/session/service/providers/provider-usage.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionEventBus } from '@/backend/services/session/service/session-event-bus';
import { workspaceDataService, workspaceNotificationService } from '@/backend/services/workspace';

const logger = createLogger('session');

function cancelTimedOutToolPrompt(sessionId: string, toolUseId: string, toolName: string): void {
  if (!acpRuntimeManager.isSessionRunning(sessionId)) {
    return;
  }
  if (!acpRuntimeManager.isSessionWorking(sessionId)) {
    return;
  }

  logger.warn('Tool call exceeded timeout; requesting ACP prompt cancel', {
    sessionId,
    toolUseId,
    toolName,
  });

  // Soft recovery only: avoid hard-stopping the ACP process so the session
  // can continue/resume without a forced restart.
  acpRuntimeManager.cancelPrompt(sessionId).catch((error: unknown) => {
    logger.warn('Failed to cancel prompt after tool call timeout', {
      sessionId,
      toolUseId,
      toolName,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export const sessionPermissionService = new SessionPermissionService({
  sessionDomainService,
});

export const codexModelCatalogService = new CodexModelCatalogService({
  listAccountIds: () => codexAccountService.getEnabledAccountIds(),
  fetchModels: async (accountId, signal, retainLifetime) => {
    signal?.throwIfAborted();
    const context = await codexAccountService.getRuntimeContext(accountId);
    signal?.throwIfAborted();
    return fetchCodexModelCatalogFromAppServer({ env: context.env, signal, retainLifetime });
  },
});

export const claudeModelCatalogService = new ClaudeModelCatalogService({
  fetchModels: fetchClaudeModelCatalogFromAcp,
});

export const providerUsageService = new ProviderUsageService({
  fetchUsage: () => fetchClaudePlanUsage(),
  accounts: codexAccountService,
});

export const sessionConfigService = new SessionConfigService({
  eventAuthority: eventSessionAuthority,
  codexModelCatalogService,
  repository: sessionRepository,
  runtimeManager: acpRuntimeManager,
  sessionDomainService,
});

/** Lifetime owner for per-session state; see session-scope.ts. */
export const sessionScope = new SessionScope();
sessionScope.register('session-configuration', {
  forget: (id) => sessionConfigService.releaseSessionConfiguration(id),
});
sessionScope.register('observed-empty-provider-session', {
  forget: (id) => acpRuntimeManager.forgetObservedEmptyProviderSession(id),
});
sessionScope.register('pr-background-delivery', {
  forget: (id) => sessionBackgroundDeliveryService.forgetSession(id),
});
sessionScope.register('provider-history-transcript-cache', {
  forget: (id) => providerHistoryTranscriptCache.forget(id),
});
// Workspace deletion forgets its cascaded sessions but never clears their stores.
sessionScope.register('session-store', {
  forget: (id) => sessionDomainService.clearSession(id),
});
sessionDomainService.on('session_permanently_deleted', (sessionId: string) => {
  sessionScope.forget(sessionId);
});
sessionDomainService.on('session_cleared', (sessionId: string) => {
  providerHistoryTranscriptCache.release(sessionId);
});

export const sessionPromptTurnCompletionService = new SessionPromptTurnCompletionService();
export const sessionRetryService = new SessionRetryService();
export const sessionLifecycleEventService = new SessionLifecycleEventService({
  store: sessionLifecycleEventAccessor,
  sessionDomainService,
});

export const acpEventProcessor = new AcpEventProcessor({
  runtimeManager: acpRuntimeManager,
  sessionDomainService,
  sessionPermissionService,
  sessionConfigService,
  onToolCallTimeout: cancelTimedOutToolPrompt,
});

export type SessionPromptService = Pick<
  SessionService,
  'configure' | 'sendSessionMessage' | 'steerSessionMessage'
>;

export const sessionLifecycleGate = new SessionLifecycleGate({
  isRuntimeStopInProgress: (sessionId) => acpRuntimeManager.isStopInProgress(sessionId),
});
export const eventOwnedWork = new EventOwnedWork(
  acpRuntimeManager,
  sessionLifecycleGate,
  sessionDomainService
);

export const sessionNotificationDeliveryService = new SessionNotificationDeliveryService({
  notificationPort: workspaceNotificationService,
  queuePort: sessionDomainService,
  transcriptPort: sessionDomainService,
  deltaPort: sessionDomainService,
});

const sessionWorkflowFinalizer = new SessionWorkflowFinalizer({
  repository: sessionRepository,
  workspaceLookup: workspaceDataService,
  sessionDomainService,
  closedSessionPersistenceService,
  lifecycleEventService: sessionLifecycleEventService,
  hydrateProviderHistory: hydrateProviderHistoryIfNeeded,
  runtimeManager: acpRuntimeManager,
  countViewers: (sessionId) => sessionEventBus.countViewers(sessionId),
});
sessionScope.register('workflow-finalizer', {
  forget: (id) => sessionWorkflowFinalizer.forgetSession(id),
});

const sessionPromptCoordinator = new SessionService({
  ownedWork: eventOwnedWork,
  eventAuthority: eventSessionAuthority,
  runtimeManager: acpRuntimeManager,
  sessionDomainService,
  acpEventProcessor,
  promptTurnCompletionService: sessionPromptTurnCompletionService,
  lifecycleEventService: sessionLifecycleEventService,
  lifecycleGate: sessionLifecycleGate,
});

export const sessionService: SessionPromptService = sessionPromptCoordinator;

registerSessionRuntimeParticipants(sessionScope, {
  promptTurnCompletion: sessionPromptTurnCompletionService,
  queuedPrompts: sessionPromptCoordinator,
  acpEvents: acpEventProcessor,
  permissions: sessionPermissionService,
});

const sessionProviderIdentityService = new SessionProviderIdentityService({
  repository: sessionRepository,
  sessionDomainService,
  archive: closedSessionPersistenceService,
  processor: acpEventProcessor,
});

const sessionRuntimeExitCoordinator = new SessionRuntimeExitCoordinator({
  eventAuthority: eventSessionAuthority,
  providerIdentityService: sessionProviderIdentityService,
  repository: sessionRepository,
  sessionDomainService,
  acpEventProcessor,
  lifecycleEventService: sessionLifecycleEventService,
  lifecycleGate: sessionLifecycleGate,
  workflowFinalizer: sessionWorkflowFinalizer,
  scope: sessionScope,
});

let sessionLifecycleServiceInstance: SessionLifecycleService;

const sessionTerminationCoordinator = new SessionTerminationCoordinator({
  eventAuthority: eventSessionAuthority,
  repository: sessionRepository,
  retryService: sessionRetryService,
  runtimeManager: acpRuntimeManager,
  sessionDomainService,
  acpEventProcessor,
  promptTurnCompletionService: sessionPromptTurnCompletionService,
  lifecycleEventService: sessionLifecycleEventService,
  lifecycleGate: sessionLifecycleGate,
  workflowFinalizer: sessionWorkflowFinalizer,
  getRuntimeSnapshot: (sessionId) => sessionLifecycleServiceInstance.getRuntimeSnapshot(sessionId),
  scope: sessionScope,
});

const sessionStartupCoordinator = new SessionStartupCoordinator({
  eventAuthority: eventSessionAuthority,
  hydrateProviderHistory: hydrateProviderHistoryIfNeeded,
  repository: sessionRepository,
  contextService: sessionContextService,
  acpEnvironment: sessionAcpEnvironment,
  runtimeManager: acpRuntimeManager,
  sessionDomainService,
  sessionConfigService,
  acpEventProcessor,
  runtimeExitCoordinator: sessionRuntimeExitCoordinator,
  lifecycleGate: sessionLifecycleGate,
  notificationDelivery: sessionNotificationDeliveryService,
  sendSessionMessage: (sessionId, content, guard): Promise<void> =>
    sessionService.sendSessionMessage(sessionId, content, ...(guard ? [guard] : [])),
  stopSession: (sessionId, options) =>
    sessionLifecycleServiceInstance.stopSession(sessionId, options),
});

sessionLifecycleServiceInstance = new SessionLifecycleService({
  startupCoordinator: sessionStartupCoordinator,
  terminationCoordinator: sessionTerminationCoordinator,
  workflowFinalizer: sessionWorkflowFinalizer,
  contextService: sessionContextService,
  runtimeManager: acpRuntimeManager,
  sessionDomainService,
  lifecycleGate: sessionLifecycleGate,
});

export { sessionLifecycleServiceInstance as sessionLifecycleService };

const initialDispatcher = new EventInitialDispatcher({
  interrupt: (id, cause, assertInitialCurrent) =>
    sessionTerminationCoordinator.interruptEventInitial(id, cause, undefined, assertInitialCurrent),
  authority: eventSessionAuthority,
  start: (id, permit) => {
    if (permit.previousResolution) {
      try {
        eventOwnedWork.assertRetryReady(permit.attempt, permit.previousResolution);
      } catch {
        // No authority to stop anything when the prior runtime proof was lost.
        throw new EventInitialDispatchInterrupted('UNKNOWN');
      }
    }
    return sessionLifecycleServiceInstance.getOrCreateSessionClient(id, { eventInitial: permit });
  },
  send: (id, text, permit) => sessionPromptCoordinator.sendInitialSessionMessage(id, text, permit),
  commit: (id, message) => sessionDomainService.commitSentUserMessage(id, message),
});
/** Dormant owner API: orchestration supplies the durable port before launching event work. */
export const dispatchAgentInitialPrompt = initialDispatcher.dispatch.bind(initialDispatcher);
export const interruptEventInitial = sessionTerminationCoordinator.interruptEventInitial.bind(
  sessionTerminationCoordinator
);
