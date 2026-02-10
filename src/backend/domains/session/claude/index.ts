// Domain: session / Claude CLI interaction layer
// Public API for the claude/ subdirectory.

export type { ClaudeClientOptions } from './client';
// Client (primary consumer-facing type)
export { ClaudeClient } from './client';
// Constants
export { CLAUDE_TIMEOUT_MS } from './constants';
export type { ResourceMonitoringOptions } from './monitoring';
// Monitoring
export { ClaudeProcessMonitor } from './monitoring';
export type { PendingInteractiveRequest } from './permission-coordinator';
export { ClaudePermissionCoordinator } from './permission-coordinator';
export type { PermissionHandler } from './permissions';

// Permissions
export { AutoApproveHandler, DeferredHandler, ModeBasedHandler } from './permissions';
export type { ClaudeProcessOptions, ExitResult } from './process';
// Process
export { ClaudeProcess } from './process';
export type { ControlResponseBody } from './protocol';
// Protocol
export { ClaudeProtocol } from './protocol';
export type { ProtocolIO } from './protocol-io';
export { ClaudeProtocolIO } from './protocol-io';
export type { RegisteredProcess } from './registry';
// Registry
export { ProcessRegistry, processRegistry } from './registry';
export type { HistoryMessage, SessionInfo } from './session';
// Session history
export { SessionManager } from './session';
// Types (selective - only commonly used types)
export type {
  AssistantMessage,
  ClaudeContentItem,
  ClaudeJson,
  ControlRequest,
  HooksConfig,
  InitializeResponseData,
  PermissionMode,
  ResultMessage,
  RewindFilesResponse,
  StreamEventMessage,
  SystemMessage,
  ToolUseContent,
  UserMessage,
} from './types';

// Process types
export type { ProcessStatus, ResourceUsage } from './types/process-types';
