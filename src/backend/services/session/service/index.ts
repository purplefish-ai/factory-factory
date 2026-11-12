// Domain: session
export { generateWorkspaceMetadata } from './metadata/workspace-metadata-generator';
export type { WorkspaceMetadataGenerationInput } from './metadata/workspace-metadata-generator';
export { AgentEventClassificationError, classifyAgentEvent } from './agent-event-classifier';
// Public API for the session domain module.
// Consumers should import from '@/backend/services/session' only.

export type {
  AgentSessionRecord,
  AcquirePRDedicatedSessionInput,
  PRDedicatedSessionAcquisition,
} from '@/backend/services/session/types';
// ACP runtime (Phase 19+)
export type {
  AcpClientOptions,
  AcpRuntimeEventHandlers,
  AcpSessionState,
  AcpSubagentsChangedEvent,
  ClaudeModelCatalogEntry,
} from './acp';
export { AcpProcessHandle, AcpRuntimeManager, acpRuntimeManager } from './acp';
// Bridge interfaces for orchestration layer wiring
export type { SessionInitPolicyBridge, SessionWorkspaceBridge } from './bridges';
// Chat services
export { sessionCommandFactories } from './chat/session-command-factories';
export type { SessionCommandFactories } from './chat/session-command-factories';
export type { EventForwarderContext } from './chat/chat-event-forwarder.service';
export { chatEventForwarderService } from './chat/chat-event-forwarder.service';
export type {
  SessionCommandContext,
  SessionCommandOutcome,
  SessionCommandError,
  SessionCommandReply,
  SessionCommandConfigService,
  SessionCommandHandler,
  SessionExecutionCommandServices,
  SessionPermissionCommandService,
} from './chat/session-command.types';
export { SessionLoadService } from './chat/session-load.service';
export type {
  PreparedSessionLoad,
  SessionLoadResult,
  SessionLoadDependencies,
} from './chat/session-load.service';
export { SessionDispatchService } from './dispatch/session-dispatch.service';
export type { DispatchOptions } from './dispatch/session-dispatch.types';
export {
  createSessionDataService,
  sessionDataService,
  type SessionDataDependencies,
  type SessionDataService,
} from './data/session-data.service';
export {
  createSessionProviderResolverService,
  sessionProviderResolverService,
  type SessionProviderResolverDependencies,
  type SessionProviderResolverService,
} from './data/session-provider-resolver.service';
export type { SessionInterceptorBridge } from './interceptor.bridge';
export { sessionInterceptorBridge } from './interceptor.bridge';
export type { ClosedSessionTranscript } from './archive/closed-session-persistence.service';
export type { ArchivedProviderIdentity } from './archive/closed-session-reader';
export { CodexModelCatalogService } from './providers/codex-model-catalog.service';
export { SessionConfigService } from './config/session.config.service';
export {
  type GetOrCreateSessionClientOptions,
  type LifecycleBridges,
  SessionLifecycleService,
  type SessionStopReason,
  type StartSessionOptions,
  type StopSessionOptions,
} from './lifecycle/session.lifecycle.service';
export { SessionStartupCancelledError } from './lifecycle/session-lifecycle-gate';
export { buildChildWorkspaceContext } from './prompt/session.prompt-builder';
export { sessionRepository } from './data/session.repository';
export {
  type PRBackgroundDeliveryPort,
  sessionBackgroundDeliveryService,
} from './delivery/session-background-delivery.service';
export type { PRDeliveryFailureReason } from './delivery/pr-delivery-failure';
export { findPRDeliveryReceipt } from './delivery/session-pr-receipt';
export type { SessionPromptService } from './composition/session-services';
export {
  acpEventProcessor,
  createSessionLoadService,
  claudeModelCatalogService,
  codexModelCatalogService,
  providerUsageService,
  sessionConfigService,
  sessionDispatchService,
  sessionLifecycleEventService,
  sessionLifecycleService,
  sessionNotificationDeliveryService,
  sessionPermissionService,
  sessionPromptTurnCompletionService,
  sessionRetryService,
  sessionService,
} from './composition/session-services';
export { AcpTraceLogger, acpTraceLogger } from './logging/acp-trace-logger.service';
// Session file logging
export { SessionFileLogger, sessionFileLogger } from './logging/session-file-logger.service';
// Core domain service (in-memory state management)
export { SessionDomainService, sessionDomainService } from './session-domain.service';
// Transport-free outbound event surface (consumed by the WebSocket adapter)
export type {
  ChatBroadcastEvent,
  SessionOutboundEvent,
  SessionViewerCountProvider,
} from './session-event-bus';
export {
  CHAT_BROADCAST_EVENT,
  SESSION_OUTBOUND_EVENT,
  SessionEventBus,
  sessionEventBus,
} from './session-event-bus';
export { voiceNarrationService } from './voice/voice-narration.service';

export type { EventAgentExecution, EventSessionCreation } from '@/shared/event-agent-launch';
