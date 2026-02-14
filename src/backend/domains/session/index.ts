// Domain: session
// Public API for the session domain module.
// Consumers should import from '@/backend/domains/session' only.

// ACP runtime (Phase 19+)
export type { AcpClientOptions, AcpRuntimeEventHandlers, AcpSessionState } from './acp';
export { AcpClientHandler, AcpProcessHandle, AcpRuntimeManager, acpRuntimeManager } from './acp';
// Bridge interfaces for orchestration layer wiring
export type { SessionInitPolicyBridge, SessionWorkspaceBridge } from './bridges';
export type { ConnectionInfo } from './chat/chat-connection.service';
// Chat services
export { chatConnectionService } from './chat/chat-connection.service';
export type { EventForwarderContext } from './chat/chat-event-forwarder.service';
export { chatEventForwarderService } from './chat/chat-event-forwarder.service';
export { chatMessageHandlerService } from './chat/chat-message-handlers.service';
export { sessionDataService } from './data/session-data.service';
export type { SessionInfo } from './data/session-file-reader';
// Session data access
export { SessionFileReader, SessionFileReader as SessionManager } from './data/session-file-reader';
export { sessionProviderResolverService } from './data/session-provider-resolver.service';
export { sessionPromptBuilder } from './lifecycle/session.prompt-builder';
export { sessionRepository } from './lifecycle/session.repository';
// Session lifecycle (start/stop/create)
export { sessionService } from './lifecycle/session.service';
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
