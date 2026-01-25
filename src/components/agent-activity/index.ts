/**
 * Agent activity components barrel exports
 */

export type { AgentActivityProps } from './agent-activity';
// Main component
export { AgentActivity, useAgentWebSocket } from './agent-activity';

// Message renderers
export {
  AssistantMessageRenderer,
  ErrorRenderer,
  MessageRenderer,
  ResultRenderer,
  StreamDeltaRenderer,
  SystemMessageRenderer,
} from './message-renderers';
export { CompactStats, StatsPanel } from './stats-panel';

// Status and stats
export { StatusBar } from './status-bar';
// Tool renderers
export { ToolCallGroupRenderer, ToolInfoRenderer } from './tool-renderers';

// Types
export type {
  AgentActivityState,
  AgentMetadata,
  AgentWebSocketMessage,
  ChatMessage,
  ClaudeMessage,
  ConnectionState,
  FileReference,
  HistoryMessage,
  MessageGroup,
  TokenStats,
  ToolInfo,
} from './types';
export { extractFileReference } from './types';

// Hook types
export type {
  UseAgentWebSocketOptions,
  UseAgentWebSocketReturn,
} from './use-agent-websocket';
