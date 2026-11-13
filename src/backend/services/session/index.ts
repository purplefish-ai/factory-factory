export type { EventAgentExecution, EventSessionCreation } from '@/shared/event-agent-launch';

// ACP runtime
export {
  type AcpClientOptions,
  AcpProcessHandle,
  type AcpRuntimeEventHandlers,
  AcpRuntimeManager,
  type AcpSessionState,
  type AcpSubagentsChangedEvent,
  acpRuntimeManager,
  type ClaudeModelCatalogEntry,
} from './service/acp';
export {
  AgentEventClassificationError,
  classifyAgentEvent,
} from './service/agent-event-classifier';
export type { ClosedSessionTranscript } from './service/archive/closed-session-persistence.service';
export type { ArchivedProviderIdentity } from './service/archive/closed-session-reader';

// Bridge interfaces for orchestration layer wiring
export type { SessionInitPolicyBridge, SessionWorkspaceBridge } from './service/bridges';

// Chat services
export {
  chatEventForwarderService,
  type EventForwarderContext,
} from './service/chat/chat-event-forwarder.service';
export {
  type SessionCommandFactories,
  sessionCommandFactories,
} from './service/chat/session-command-factories';
export type {
  SessionCommandConfigService,
  SessionCommandContext,
  SessionCommandError,
  SessionCommandHandler,
  SessionCommandOutcome,
  SessionCommandReply,
  SessionExecutionCommandServices,
  SessionPermissionCommandService,
} from './service/chat/session-command.types';
export {
  type PreparedSessionLoad,
  type SessionLoadDependencies,
  type SessionLoadResult,
  SessionLoadService,
} from './service/chat/session-load.service';

// Composition roots and service singletons
export {
  dispatchAgentInitialPrompt,
  eventOwnedWork,
  interruptEventInitial,
} from './service/composition/session-core-services';
export {
  acpEventProcessor,
  claudeModelCatalogService,
  codexModelCatalogService,
  createSessionLoadService,
  providerUsageService,
  sessionConfigService,
  sessionDispatchService,
  sessionLifecycleEventService,
  sessionLifecycleService,
  sessionNotificationDeliveryService,
  sessionPermissionService,
  type SessionPromptService,
  sessionPromptTurnCompletionService,
  sessionRetryService,
  sessionService,
} from './service/composition/session-services';
export { SessionConfigService } from './service/config/session.config.service';

// Session data
export {
  createSessionDataService,
  type SessionDataDependencies,
  type SessionDataService,
  sessionDataService,
} from './service/data/session-data.service';
export {
  createSessionProviderResolverService,
  type SessionProviderResolverDependencies,
  type SessionProviderResolverService,
  sessionProviderResolverService,
} from './service/data/session-provider-resolver.service';
export { sessionRepository } from './service/data/session.repository';

// Delivery
export type { PRDeliveryFailureReason } from './service/delivery/pr-delivery-failure';
export {
  type PRBackgroundDeliveryPort,
  sessionBackgroundDeliveryService,
} from './service/delivery/session-background-delivery.service';
export { findPRDeliveryReceipt } from './service/delivery/session-pr-receipt';

// Dispatch
export { EventInitialDispatchInterrupted } from './service/dispatch/event-initial-dispatch';
export { SessionDispatchService } from './service/dispatch/session-dispatch.service';
export type { DispatchOptions } from './service/dispatch/session-dispatch.types';

// Event-owned sessions
export { withEventEvidenceDeadline } from './service/event-agent/event-evidence-deadline';
export { eventSessionAuthority } from './service/event-agent/event-session-authority';
export { EventSessionFenceError } from './service/event-agent/event-session-fence-error';

export {
  type SessionInterceptorBridge,
  sessionInterceptorBridge,
} from './service/interceptor.bridge';

// Lifecycle
export { SessionStartupCancelledError } from './service/lifecycle/session-lifecycle-gate';
export {
  type GetOrCreateSessionClientOptions,
  type LifecycleBridges,
  SessionLifecycleService,
  type SessionStopReason,
  type StartSessionOptions,
  type StopSessionOptions,
} from './service/lifecycle/session.lifecycle.service';

// ACP trace and session file logging
export { AcpTraceLogger, acpTraceLogger } from './service/logging/acp-trace-logger.service';
export {
  SessionFileLogger,
  sessionFileLogger,
} from './service/logging/session-file-logger.service';

export {
  generateWorkspaceMetadata,
  type WorkspaceMetadataGenerationInput,
} from './service/metadata/workspace-metadata-generator';
export { buildChildWorkspaceContext } from './service/prompt/session.prompt-builder';
export { CodexModelCatalogService } from './service/providers/codex-model-catalog.service';

// Core domain service (in-memory state management)
export { SessionDomainService, sessionDomainService } from './service/session-domain.service';

// Transport-free outbound event surface (consumed by the WebSocket adapter)
export {
  CHAT_BROADCAST_EVENT,
  type ChatBroadcastEvent,
  SESSION_OUTBOUND_EVENT,
  SessionEventBus,
  sessionEventBus,
  type SessionOutboundEvent,
  type SessionViewerCountProvider,
} from './service/session-event-bus';
export { voiceNarrationService } from './service/voice/voice-narration.service';

export type {
  AcquirePRDedicatedSessionInput,
  AgentSessionRecord,
  PRDedicatedSessionAcquisition,
} from './types';
