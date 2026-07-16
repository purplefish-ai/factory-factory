// Domain: session
// Public API for the session domain module.
// Consumers should import from '@/backend/services/session' only.

// ACP runtime (Phase 19+)
export type { AcpClientOptions, AcpRuntimeEventHandlers, AcpSessionState } from './acp';
export {
  AcpClientHandler,
  AcpProcessHandle,
  AcpRuntimeManager,
  acpRuntimeManager,
  CodexAppServerAcpAdapter,
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
export { sessionPromptBuilder } from './lifecycle/session.prompt-builder';
export { sessionRepository } from './lifecycle/session.repository';
// Session lifecycle (start/stop/create)
export { createSessionService, sessionService } from './lifecycle/session.service';
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
export { sessionDomainService } from './session-domain.service';
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
