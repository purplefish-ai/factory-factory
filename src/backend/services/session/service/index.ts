// Domain: session
// Public API for the session domain module.
// Consumers should import from '@/backend/services/session' only.

export type { AgentSessionRecord } from '@/backend/services/session/types';
// ACP runtime (Phase 19+)
export type {
  AcpClientOptions,
  AcpRuntimeEventHandlers,
  AcpSessionState,
  AcpSubagentsChangedEvent,
  ClaudeModelCatalogEntry,
} from './acp';
export {
  AcpClientHandler,
  AcpProcessHandle,
  AcpRuntimeManager,
  acpRuntimeManager,
  CodexAppServerAcpAdapter,
  fetchClaudeModelCatalogFromAcp,
  fetchCodexModelCatalogFromAppServer,
  runCodexAppServerAcpAdapter,
} from './acp';
// Bridge interfaces for orchestration layer wiring
export type { SessionInitPolicyBridge, SessionWorkspaceBridge } from './bridges';
// Chat services
export type { EventForwarderContext } from './chat/chat-event-forwarder.service';
export { chatEventForwarderService } from './chat/chat-event-forwarder.service';
export { chatMessageHandlerService } from './chat/chat-message-handlers.service';
export { sessionDataService } from './data/session-data.service';
export { sessionProviderResolverService } from './data/session-provider-resolver.service';
export type { SessionInterceptorBridge } from './interceptor.bridge';
export { sessionInterceptorBridge } from './interceptor.bridge';
export type { ClosedSessionTranscript } from './lifecycle/closed-session-persistence.service';
export { SessionConfigService } from './lifecycle/session.config.service';
export {
  SessionLifecycleService,
  type SessionStopReason,
} from './lifecycle/session.lifecycle.service';
export { SessionPermissionService } from './lifecycle/session.permission.service';
export {
  buildChildWorkspaceContext,
  sessionPromptBuilder,
} from './lifecycle/session.prompt-builder';
export { sessionRepository } from './lifecycle/session.repository';
export { SessionService } from './lifecycle/session.service';
export type { SessionPromptService } from './lifecycle/session-services';
export {
  acpEventProcessor,
  sessionConfigService,
  sessionLifecycleEventService,
  sessionLifecycleService,
  sessionPermissionService,
  sessionPromptTurnCompletionService,
  sessionRetryService,
  sessionService,
} from './lifecycle/session-services';
export { AcpTraceLogger, acpTraceLogger } from './logging/acp-trace-logger.service';
// Session file logging
export { SessionFileLogger, sessionFileLogger } from './logging/session-file-logger.service';
// Runtime types
export type {
  ProviderRuntimeManager,
  RuntimeCreatedCallback,
  RuntimeEventHandlers,
} from './runtime';
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
