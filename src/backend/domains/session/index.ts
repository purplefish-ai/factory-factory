// Domain: session
// Public API for the session domain module.
// Consumers should import from '@/backend/domains/session' only.

// Bridge interfaces for orchestration layer wiring
export type { SessionInitPolicyBridge, SessionWorkspaceBridge } from './bridges';
export type { ConnectionInfo } from './chat/chat-connection.service';
// Chat services
export { chatConnectionService } from './chat/chat-connection.service';
export type { EventForwarderContext } from './chat/chat-event-forwarder.service';
export { chatEventForwarderService } from './chat/chat-event-forwarder.service';
export type { ChatMessage } from './chat/chat-message-handlers.service';
export { chatMessageHandlerService } from './chat/chat-message-handlers.service';
// Claude client (primary type for consumers)
// Protocol types (commonly used by consumers)
export type {
  AssistantMessage,
  ClaudeClient,
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
// Session history
export { ClaudeProcess, ProcessRegistry, processRegistry, SessionManager } from './claude';
// Session data access
export { sessionDataService } from './data/session-data.service';
export type { SessionProcessManager } from './lifecycle/session.process-manager';
export { sessionProcessManager } from './lifecycle/session.process-manager';
export { sessionPromptBuilder } from './lifecycle/session.prompt-builder';
export { sessionRepository } from './lifecycle/session.repository';
export type { ClientCreatedCallback } from './lifecycle/session.service';
// Session lifecycle (start/stop/create)
export { sessionService } from './lifecycle/session.service';
// Session file logging
export { SessionFileLogger, sessionFileLogger } from './logging/session-file-logger.service';
// Core domain service (in-memory state management)
export { sessionDomainService } from './session-domain.service';
