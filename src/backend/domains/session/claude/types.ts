/**
 * TypeScript type definitions for the Claude CLI streaming JSON protocol.
 *
 * This file provides comprehensive types for the bidirectional JSON streaming
 * protocol used by the Claude Code CLI when invoked with:
 *   --output-format stream-json --input-format stream-json --permission-prompt-tool stdio
 *
 * @see docs/claude/claude-code-cli-reference.md
 */

import { z } from 'zod';
import type {
  AskUserQuestion,
  AskUserQuestionOption,
  ClaudeContentItem,
  ClaudeMessagePayload,
  ClaudeStreamEvent,
  ClaudeUsage,
  CommandInfo,
  ContentBlockDelta,
  ImageItem,
  InputJsonDelta,
  ModelUsage,
  PluginInfo,
  ModelInfo as SharedModelInfo,
  TextContent,
  TextDelta,
  TextItem,
  ThinkingContent,
  ThinkingDelta,
  ToolDefinition,
  ToolResultContent,
  ToolResultContentValue,
  ToolUseContent,
} from '@/shared/claude';

export type {
  AskUserQuestion,
  AskUserQuestionOption,
  ClaudeContentItem,
  ClaudeStreamEvent,
  ClaudeUsage,
  CommandInfo,
  ContentBlockDelta,
  InputJsonDelta,
  ImageItem,
  ModelUsage,
  PluginInfo,
  TextContent,
  TextDelta,
  TextItem,
  ThinkingContent,
  ThinkingDelta,
  ToolDefinition,
  ToolResultContent,
  ToolResultContentValue,
  ToolUseContent,
};

export {
  isImageContent,
  isTextContent,
  isThinkingContent,
  isToolResultContent,
  isToolUseContent,
} from '@/shared/claude';

// =============================================================================
// Enums and Constants
// =============================================================================

/**
 * Permission modes for tool execution control.
 */
export type PermissionMode =
  | 'default' // Ask permission for each tool
  | 'acceptEdits' // Auto-accept file edits
  | 'plan' // Planning mode - manual review before execution
  | 'bypassPermissions' // Auto-approve everything
  | 'delegate' // Delegated mode - treat like default
  | 'dontAsk'; // Don't ask - deny non-pre-approved tools

/**
 * System message subtypes indicating the nature of the system message.
 */
export type SystemMessageSubtype =
  | 'init'
  | 'status'
  | 'compact_boundary'
  | 'hook_started'
  | 'hook_response';

/**
 * Hook event names for PreToolUse, Stop, and other SDK hooks.
 */
export type HookEventName =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PermissionRequest'
  | 'Setup';

// =============================================================================
// Shared Claude Protocol Types
// =============================================================================

/**
 * Shared protocol types are re-exported above from src/shared/claude.
 * Use those definitions to avoid client/server drift.
 */

/**
 * Message delta with stop information.
 */
export type MessageDelta = NonNullable<
  Extract<ClaudeStreamEvent, { type: 'message_delta' }>['delta']
>;

/**
 * Stream event: message_start - beginning of a new message.
 */
export type MessageStartEvent = Extract<ClaudeStreamEvent, { type: 'message_start' }>;

/**
 * Stream event: content_block_start - beginning of a content block.
 */
export type ContentBlockStartEvent = Extract<ClaudeStreamEvent, { type: 'content_block_start' }>;

/**
 * Stream event: content_block_delta - incremental update to a content block.
 */
export type ContentBlockDeltaEvent = Extract<ClaudeStreamEvent, { type: 'content_block_delta' }>;

/**
 * Stream event: content_block_stop - end of a content block.
 */
export type ContentBlockStopEvent = Extract<ClaudeStreamEvent, { type: 'content_block_stop' }>;

/**
 * Stream event: message_delta - message-level update with usage stats.
 */
export type MessageDeltaEvent = Extract<ClaudeStreamEvent, { type: 'message_delta' }>;

/**
 * Stream event: message_stop - end of the message.
 */
export type MessageStopEvent = Extract<ClaudeStreamEvent, { type: 'message_stop' }>;

// =============================================================================
// Message Types
// =============================================================================

/**
 * A Claude message containing role and content.
 */
export type ClaudeMessage = ClaudeMessagePayload;

// =============================================================================
// Initialize Response Metadata
// =============================================================================

/**
 * Model option information returned in initialize response.
 */
export interface ModelInfo extends SharedModelInfo {
  description: string;
}

/**
 * Account information returned in initialize response.
 * All fields are optional per the official Claude Agent SDK spec.
 */
export interface AccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
}

/**
 * Data returned in the initialize response from CLI.
 */
export interface InitializeResponseData {
  commands: CommandInfo[];
  output_style: string;
  available_output_styles: string[];
  models: ModelInfo[];
  account: AccountInfo;
}

/**
 * Zod schema for InitializeResponseData runtime validation.
 */
export const InitializeResponseDataSchema = z
  .object({
    commands: z.array(z.object({ name: z.string(), description: z.string() }).passthrough()),
    output_style: z.string(),
    available_output_styles: z.array(z.string()),
    models: z.array(
      z
        .object({ value: z.string(), displayName: z.string(), description: z.string() })
        .passthrough()
    ),
    account: z
      .object({
        email: z.string().optional(),
        organization: z.string().optional(),
        subscriptionType: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

// =============================================================================
// Permission Update Types
// =============================================================================

/**
 * Permission update for modifying permission rules.
 */
export interface PermissionUpdate {
  type: 'setMode' | 'addRules' | 'removeRules' | 'clearRules';
  mode?: PermissionMode;
  destination?: 'session' | 'userSettings' | 'projectSettings' | 'localSettings';
  rules?: Array<{ tool_name: string; rule_content?: string }>;
  behavior?: string;
  directories?: string[];
}

// =============================================================================
// Control Request Types (CLI -> SDK)
// =============================================================================

/**
 * Permission request for tool execution.
 * CLI sends this when a tool requires approval.
 */
export interface CanUseToolRequest {
  subtype: 'can_use_tool';
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
  permission_suggestions?: PermissionUpdate[];
  blocked_paths?: string;
}

/**
 * Input data for hook callbacks.
 */
export interface HookCallbackInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  stop_hook_active?: boolean;
}

/**
 * Hook callback request from CLI.
 * Sent when a PreToolUse or Stop hook needs to be evaluated.
 */
export interface HookCallbackRequest {
  subtype: 'hook_callback';
  callback_id: string;
  input: HookCallbackInput;
  tool_use_id?: string;
}

/**
 * Union of all request types that CLI can send to SDK.
 */
export type CliToSdkRequest = CanUseToolRequest | HookCallbackRequest;

// =============================================================================
// Control Request Types (SDK -> CLI)
// =============================================================================

/**
 * Hook configuration for PreToolUse hooks.
 */
export interface PreToolUseHookConfig {
  matcher?: string;
  hookCallbackIds: string[];
}

/**
 * Hook configuration for Stop hooks.
 */
export interface StopHookConfig {
  hookCallbackIds: string[];
}

/**
 * Hooks configuration for initialize request.
 */
export interface HooksConfig {
  PreToolUse?: PreToolUseHookConfig[];
  Stop?: StopHookConfig[];
}

/**
 * Initialize request - first message SDK sends to CLI.
 */
export interface InitializeRequest {
  subtype: 'initialize';
  hooks?: HooksConfig;
}

/**
 * Request to set the permission mode.
 */
export interface SetPermissionModeRequest {
  subtype: 'set_permission_mode';
  mode: PermissionMode;
}

/**
 * Request to interrupt the current execution.
 */
export interface InterruptRequest {
  subtype: 'interrupt';
}

/**
 * Request to set the model.
 */
export interface SetModelRequest {
  subtype: 'set_model';
  model?: string;
}

/**
 * Request to set max thinking tokens.
 */
export interface SetMaxThinkingTokensRequest {
  subtype: 'set_max_thinking_tokens';
  max_thinking_tokens: number | null;
}

/**
 * Request to rewind files to a previous state.
 */
export interface RewindFilesRequest {
  subtype: 'rewind_files';
  user_message_id: string;
  dry_run?: boolean;
}

/**
 * Response from rewind files request.
 * Contains list of files that were/would be affected.
 */
export interface RewindFilesResponse {
  /** List of file paths that were/would be reverted */
  affected_files?: string[];
}

/**
 * Zod schema for RewindFilesResponse runtime validation.
 */
export const RewindFilesResponseSchema = z
  .object({
    affected_files: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * Union of all request subtypes SDK can send to CLI.
 */
export type SdkToCliRequest =
  | InitializeRequest
  | SetPermissionModeRequest
  | InterruptRequest
  | SetModelRequest
  | SetMaxThinkingTokensRequest
  | RewindFilesRequest;

// =============================================================================
// Control Response Types (SDK -> CLI)
// =============================================================================

/**
 * Response data to allow tool execution.
 *
 * Note: updatedInput is required by Claude CLI's Zod schema validation.
 * Pass the original tool input to keep it unchanged, or pass modified input
 * to override what the tool receives.
 */
export interface AllowResponseData {
  behavior: 'allow';
  updatedInput: Record<string, unknown>;
  updatedPermissions?: PermissionUpdate[];
}

/**
 * Response data to deny tool execution.
 */
export interface DenyResponseData {
  behavior: 'deny';
  message: string;
  interrupt?: boolean;
}

/**
 * Hook-specific output for PreToolUse hooks.
 */
export interface PreToolUseHookOutput {
  hookEventName: 'PreToolUse';
  permissionDecision: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;
}

/**
 * Response data for PreToolUse hook callbacks.
 */
export interface PreToolUseHookResponseData {
  hookSpecificOutput: PreToolUseHookOutput;
}

/**
 * Response data for Stop hook callbacks.
 */
export interface StopHookResponseData {
  decision: 'approve' | 'block';
  reason?: string;
}

/**
 * Success response wrapper.
 */
export interface SuccessResponse<T> {
  subtype: 'success';
  request_id: string;
  response: T;
}

/**
 * Union of all response data types.
 */
export type ControlResponseData =
  | AllowResponseData
  | DenyResponseData
  | PreToolUseHookResponseData
  | StopHookResponseData
  | InitializeResponseData;

// =============================================================================
// Tool-Specific Input Types
// =============================================================================

/**
 * Input for the Task tool (subagent creation).
 */
export interface TaskToolInput {
  subagent_type?: string;
  description?: string;
  prompt?: string;
  model?: string;
  max_turns?: number;
  run_in_background?: boolean;
  resume?: string;
}

/**
 * Input for the AskUserQuestion tool.
 */
export interface AskUserQuestionInput {
  questions: AskUserQuestion[];
}

/**
 * Response format for AskUserQuestion tool results.
 */
export interface AskUserQuestionResponse {
  answers: Record<string, string | string[]>;
}

// =============================================================================
// Top-Level ClaudeJson Message Types
// =============================================================================

/**
 * System message - initialization, status updates, hook events.
 */
export interface SystemMessage {
  type: 'system';
  subtype?: SystemMessageSubtype | string;
  session_id?: string;
  cwd?: string;
  tools?: ToolDefinition[];
  model?: string;
  apiKeySource?: string;
  status?: string;
  slash_commands?: string[];
  plugins?: PluginInfo[];
  // Hook-specific fields
  hook_id?: string;
  hook_name?: string;
  hook_event?: string;
  uuid?: string;
  // Hook response fields
  output?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  outcome?: string;
}

/**
 * Assistant message - model responses with content array.
 */
export interface AssistantMessage {
  type: 'assistant';
  session_id?: string;
  message: ClaudeMessage;
}

/**
 * User message - user input (including synthetic messages).
 */
export interface UserMessage {
  type: 'user';
  session_id?: string;
  isSynthetic?: boolean;
  isReplay?: boolean;
  message: ClaudeMessage;
  /** SDK-assigned UUID for this user message (used for rewind_files) */
  uuid?: string;
}

/**
 * Stream event message - real-time streaming deltas.
 */
export interface StreamEventMessage {
  type: 'stream_event';
  session_id?: string;
  parent_tool_use_id?: string;
  uuid?: string;
  event: ClaudeStreamEvent;
}

/**
 * Permission denial information from SDK.
 */
export interface SDKPermissionDenial {
  toolName: string;
  message: string;
  timestamp?: string;
}

/**
 * Result message - final conversation result with usage stats.
 * Supports both camelCase and snake_case field names.
 */
export interface ResultMessage {
  type: 'result';
  subtype?:
    | 'success'
    | 'error'
    | 'error_during_execution'
    | 'error_max_turns'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries';
  // Session ID (both formats supported)
  session_id?: string;
  sessionId?: string;
  // Error flags (both formats supported)
  isError?: boolean;
  is_error?: boolean;
  // Duration (both formats supported)
  durationMs?: number;
  duration_ms?: number;
  // API duration
  duration_api_ms?: number;
  // Turn count (both formats supported)
  numTurns?: number;
  num_turns?: number;
  // Result data
  result?: unknown;
  error?: string;
  usage?: ClaudeUsage;
  // Model usage (both formats supported)
  modelUsage?: Record<string, { contextWindow?: number }>;
  model_usage?: Record<string, { contextWindow?: number }>;
  // Cost information
  total_cost_usd?: number;
  // Permission denials
  permission_denials?: SDKPermissionDenial[];
  // Structured output
  structured_output?: unknown;
}

/**
 * Tool progress message - sent during long-running tool execution.
 */
export interface ToolProgressMessage {
  type: 'tool_progress';
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id?: string;
  elapsed_time_seconds: number;
  uuid: string;
  session_id: string;
}

/**
 * Tool use summary message - summarizes completed tool executions.
 */
export interface ToolUseSummaryMessage {
  type: 'tool_use_summary';
  summary: string;
  preceding_tool_use_ids: string[];
  uuid: string;
  session_id: string;
}

/**
 * Keep-alive message - sent periodically to maintain connection.
 */
export interface KeepAliveMessage {
  type: 'keep_alive';
}

/**
 * Control request message - permission/hook requests from CLI.
 */
export interface ControlRequest {
  type: 'control_request';
  request_id: string;
  request: CliToSdkRequest;
}

/**
 * Control response message - responses to control requests (SDK sends).
 */
export interface ControlResponse {
  type: 'control_response';
  response: SuccessResponse<ControlResponseData>;
}

/**
 * Control cancel request - CLI cancelled a pending request.
 * No response is required.
 */
export interface ControlCancelRequest {
  type: 'control_cancel_request';
  request_id: string;
}

/**
 * User message request - SDK sends user message to CLI.
 */
export interface UserMessageRequest {
  type: 'user';
  message: {
    role: 'user';
    content: string;
  };
}

/**
 * Control request wrapper for SDK -> CLI requests.
 */
export interface SdkControlRequest {
  type: 'control_request';
  request_id: string;
  request: SdkToCliRequest;
}

// =============================================================================
// Top-Level ClaudeJson Union Type
// =============================================================================

/**
 * Union of all possible message types from the CLI.
 * Messages are discriminated by the `type` field.
 */
export type ClaudeJson =
  | SystemMessage
  | AssistantMessage
  | UserMessage
  | StreamEventMessage
  | ResultMessage
  | ControlRequest
  | ControlResponse
  | ControlCancelRequest
  | ToolProgressMessage
  | ToolUseSummaryMessage
  | KeepAliveMessage;

/**
 * Union of all message types that SDK can send to CLI.
 */
export type SdkToCliMessage = SdkControlRequest | ControlResponse | UserMessageRequest;

// =============================================================================
// Zod Schemas for Runtime Validation
// =============================================================================

/**
 * Zod schema for ClaudeJson runtime validation.
 * Validates the discriminated union based on the `type` field.
 * Uses passthrough() to allow additional fields from Claude CLI.
 */
export const ClaudeJsonSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard to check if a message is a SystemMessage.
 */
export function isSystemMessage(msg: ClaudeJson): msg is SystemMessage {
  return msg.type === 'system';
}

/**
 * Type guard to check if a message is an AssistantMessage.
 */
export function isAssistantMessage(msg: ClaudeJson): msg is AssistantMessage {
  return msg.type === 'assistant';
}

/**
 * Type guard to check if a message is a UserMessage.
 */
export function isUserMessage(msg: ClaudeJson): msg is UserMessage {
  return msg.type === 'user';
}

/**
 * Type guard to check if a message is a StreamEventMessage.
 */
export function isStreamEventMessage(msg: ClaudeJson): msg is StreamEventMessage {
  return msg.type === 'stream_event';
}

/**
 * Type guard to check if a message is a ResultMessage.
 */
export function isResultMessage(msg: ClaudeJson): msg is ResultMessage {
  return msg.type === 'result';
}

/**
 * Type guard to check if a message is a ControlRequest.
 */
export function isControlRequest(msg: ClaudeJson): msg is ControlRequest {
  return msg.type === 'control_request';
}

/**
 * Type guard to check if a message is a ControlResponse.
 */
export function isControlResponse(msg: ClaudeJson): msg is ControlResponse {
  return msg.type === 'control_response';
}

/**
 * Type guard to check if a message is a ControlCancelRequest.
 */
export function isControlCancelRequest(msg: ClaudeJson): msg is ControlCancelRequest {
  return msg.type === 'control_cancel_request';
}

/**
 * Type guard to check if a control request is a CanUseToolRequest.
 */
export function isCanUseToolRequest(req: CliToSdkRequest): req is CanUseToolRequest {
  return req.subtype === 'can_use_tool';
}

/**
 * Type guard to check if a control request is a HookCallbackRequest.
 */
export function isHookCallbackRequest(req: CliToSdkRequest): req is HookCallbackRequest {
  return req.subtype === 'hook_callback';
}

/**
 * Type guard to check if a stream event is a MessageStartEvent.
 */
export function isMessageStartEvent(event: ClaudeStreamEvent): event is MessageStartEvent {
  return event.type === 'message_start';
}

/**
 * Type guard to check if a stream event is a ContentBlockStartEvent.
 */
export function isContentBlockStartEvent(
  event: ClaudeStreamEvent
): event is ContentBlockStartEvent {
  return event.type === 'content_block_start';
}

/**
 * Type guard to check if a stream event is a ContentBlockDeltaEvent.
 */
export function isContentBlockDeltaEvent(
  event: ClaudeStreamEvent
): event is ContentBlockDeltaEvent {
  return event.type === 'content_block_delta';
}

/**
 * Type guard to check if a stream event is a ContentBlockStopEvent.
 */
export function isContentBlockStopEvent(event: ClaudeStreamEvent): event is ContentBlockStopEvent {
  return event.type === 'content_block_stop';
}

/**
 * Type guard to check if a stream event is a MessageDeltaEvent.
 */
export function isMessageDeltaEvent(event: ClaudeStreamEvent): event is MessageDeltaEvent {
  return event.type === 'message_delta';
}

/**
 * Type guard to check if a stream event is a MessageStopEvent.
 */
export function isMessageStopEvent(event: ClaudeStreamEvent): event is MessageStopEvent {
  return event.type === 'message_stop';
}

/**
 * Type guard to check if a message is a ToolProgressMessage.
 */
export function isToolProgressMessage(msg: ClaudeJson): msg is ToolProgressMessage {
  return msg.type === 'tool_progress';
}

/**
 * Type guard to check if a message is a ToolUseSummaryMessage.
 */
export function isToolUseSummaryMessage(msg: ClaudeJson): msg is ToolUseSummaryMessage {
  return msg.type === 'tool_use_summary';
}

/**
 * Type guard to check if a message is a KeepAliveMessage.
 */
export function isKeepAliveMessage(msg: ClaudeJson): msg is KeepAliveMessage {
  return msg.type === 'keep_alive';
}

/**
 * Type guard to check if a delta is an InputJsonDelta.
 */
export function isInputJsonDelta(delta: ContentBlockDelta): delta is InputJsonDelta {
  return delta.type === 'input_json_delta';
}

// =============================================================================
// System Message Subtype Interfaces
// =============================================================================

/**
 * System init message - sent at session start with session info and available tools.
 */
export interface SystemInitMessage extends SystemMessage {
  type: 'system';
  subtype: 'init';
  session_id?: string;
  cwd?: string;
  tools?: ToolDefinition[];
  model?: string;
  apiKeySource?: string;
  slash_commands?: string[];
  plugins?: PluginInfo[];
}

/**
 * System status message - sent when session status or permission mode changes.
 */
export interface SystemStatusMessage extends SystemMessage {
  type: 'system';
  subtype: 'status';
  status?: string;
  permission_mode?: string;
}

/**
 * System compact boundary message - indicates context was compacted.
 */
export interface SystemCompactBoundaryMessage extends SystemMessage {
  type: 'system';
  subtype: 'compact_boundary';
}

/**
 * System hook started message - indicates a hook is starting execution.
 */
export interface SystemHookStartedMessage extends SystemMessage {
  type: 'system';
  subtype: 'hook_started';
  hook_id?: string;
  hook_name?: string;
  hook_event?: string;
}

/**
 * System hook response message - indicates a hook has completed.
 */
export interface SystemHookResponseMessage extends SystemMessage {
  type: 'system';
  subtype: 'hook_response';
  hook_id?: string;
  output?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  outcome?: string;
}

// =============================================================================
// System Message Subtype Type Guards
// =============================================================================

/**
 * Type guard to check if a ClaudeJson is a SystemInitMessage.
 */
export function isSystemInitMessage(msg: ClaudeJson): msg is SystemInitMessage {
  return msg.type === 'system' && (msg as SystemMessage).subtype === 'init';
}

/**
 * Type guard to check if a ClaudeJson is a SystemStatusMessage.
 */
export function isSystemStatusMessage(msg: ClaudeJson): msg is SystemStatusMessage {
  return msg.type === 'system' && (msg as SystemMessage).subtype === 'status';
}

/**
 * Type guard to check if a ClaudeJson is a SystemCompactBoundaryMessage.
 */
export function isSystemCompactBoundaryMessage(
  msg: ClaudeJson
): msg is SystemCompactBoundaryMessage {
  return msg.type === 'system' && (msg as SystemMessage).subtype === 'compact_boundary';
}

/**
 * Type guard to check if a ClaudeJson is a SystemHookStartedMessage.
 */
export function isSystemHookStartedMessage(msg: ClaudeJson): msg is SystemHookStartedMessage {
  return msg.type === 'system' && (msg as SystemMessage).subtype === 'hook_started';
}

/**
 * Type guard to check if a ClaudeJson is a SystemHookResponseMessage.
 */
export function isSystemHookResponseMessage(msg: ClaudeJson): msg is SystemHookResponseMessage {
  return msg.type === 'system' && (msg as SystemMessage).subtype === 'hook_response';
}
