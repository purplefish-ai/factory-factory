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
// Claude client (primary type for consumers)
// Protocol types (commonly used by consumers)
export type {
  AssistantMessage,
  ClaudeClientOptions,
  ClaudeJson,
  ControlRequest,
  ExitResult,
  HistoryMessage,
  InitializeResponseData,
  PermissionMode,
  ProcessStatus,
  RegisteredProcess,
  ResourceUsage,
  ResultMessage,
  SessionInfo,
  StreamEventMessage,
  SystemMessage,
  ToolUseContent,
  UserMessage,
} from './claude';
// Session history + Claude client (class, used as both type and value)
export {
  ClaudeClient,
  ClaudeProcess,
  ProcessRegistry,
  processRegistry,
  SessionManager,
} from './claude';
export { sessionDataService } from './data/session-data.service';
// Session data access
export { sessionProviderResolverService } from './data/session-provider-resolver.service';
export type { SessionProcessManager } from './lifecycle/session.process-manager';
export { sessionProcessManager } from './lifecycle/session.process-manager';
export { sessionPromptBuilder } from './lifecycle/session.prompt-builder';
export { sessionRepository } from './lifecycle/session.repository';
export type { ClientCreatedCallback } from './lifecycle/session.service';
// Session lifecycle (start/stop/create)
export { sessionService } from './lifecycle/session.service';
// Session file logging
export { SessionFileLogger, sessionFileLogger } from './logging/session-file-logger.service';
// Provider adapters + runtime managers (internal migration seam)
export type {
  CanonicalAgentMessageEvent,
  CanonicalAgentMessageKind,
  SessionProvider,
  SessionProviderAdapter,
} from './providers';
export {
  ClaudeSessionProviderAdapter,
  CodexSessionProviderAdapter,
  claudeSessionProviderAdapter,
  codexSessionProviderAdapter,
} from './providers';
export type {
  ClaudeRuntimeCreatedCallback,
  ClaudeRuntimeEventHandlers,
  ProviderRuntimeManager,
  RuntimeCreatedCallback,
  RuntimeEventHandlers,
} from './runtime';
export {
  ClaudeRuntimeManager,
  CodexAppServerManager,
  claudeRuntimeManager,
  codexAppServerManager,
} from './runtime';

// Core domain service (in-memory state management)
export { sessionDomainService } from './session-domain.service';
