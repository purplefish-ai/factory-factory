/**
 * TypeScript type definitions for the Claude CLI streaming JSON protocol.
 *
 * This file provides comprehensive types for the bidirectional JSON streaming
 * protocol used by the Claude Code CLI when invoked with:
 *   --output-format stream-json --input-format stream-json --permission-prompt-tool stdio
 *
 * @see docs/claude/claude-code-cli-reference.md
 */

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
  | 'bypassPermissions'; // Auto-approve everything

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
 * Hook event names for PreToolUse and Stop hooks.
 */
export type HookEventName = 'PreToolUse' | 'Stop';

// =============================================================================
// Content Item Types
// =============================================================================

/**
 * Text content block in a message.
 */
export interface TextContent {
  type: 'text';
  text: string;
}

/**
 * Thinking/reasoning content block (extended thinking).
 */
export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

/**
 * Tool use content block - Claude requesting to use a tool.
 */
export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool result content block - result of a tool execution.
 */
export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: ToolResultContentValue;
  is_error?: boolean;
}

/**
 * Union of all content item types that can appear in a message.
 */
export type ClaudeContentItem = TextContent | ThinkingContent | ToolUseContent | ToolResultContent;

// =============================================================================
// Tool Result Content Value Types
// =============================================================================

/**
 * Text item in a tool result content array.
 */
export interface TextItem {
  type: 'text';
  text: string;
}

/**
 * Image item in a tool result content array (base64 encoded).
 */
export interface ImageItem {
  type: 'image';
  source: {
    type: 'base64';
    data: string;
    media_type: string;
  };
}

/**
 * Value type for tool_result content field.
 * Can be a plain string (text or JSON) or an array of text/image items.
 */
export type ToolResultContentValue = string | Array<TextItem | ImageItem>;

// =============================================================================
// Stream Event Types
// =============================================================================

/**
 * Delta for text content blocks during streaming.
 */
export interface TextDelta {
  type: 'text_delta';
  text: string;
}

/**
 * Delta for thinking content blocks during streaming.
 */
export interface ThinkingDelta {
  type: 'thinking_delta';
  thinking: string;
}

/**
 * Union of content block delta types.
 */
export type ContentBlockDelta = TextDelta | ThinkingDelta;

/**
 * Message delta with stop information.
 */
export interface MessageDelta {
  stop_reason?: string;
  stop_sequence?: string;
}

/**
 * Token usage statistics.
 */
export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  service_tier?: string;
}

/**
 * Stream event: message_start - beginning of a new message.
 */
export interface MessageStartEvent {
  type: 'message_start';
  message: ClaudeMessage;
}

/**
 * Stream event: content_block_start - beginning of a content block.
 */
export interface ContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: ClaudeContentItem;
}

/**
 * Stream event: content_block_delta - incremental update to a content block.
 */
export interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: ContentBlockDelta;
}

/**
 * Stream event: content_block_stop - end of a content block.
 */
export interface ContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

/**
 * Stream event: message_delta - message-level update with usage stats.
 */
export interface MessageDeltaEvent {
  type: 'message_delta';
  delta?: MessageDelta;
  usage?: ClaudeUsage;
}

/**
 * Stream event: message_stop - end of the message.
 */
export interface MessageStopEvent {
  type: 'message_stop';
}

/**
 * Union of all stream event types.
 */
export type ClaudeStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent;

// =============================================================================
// Message Types
// =============================================================================

/**
 * A Claude message containing role and content.
 */
export interface ClaudeMessage {
  id?: string;
  type?: string;
  role: 'assistant' | 'user';
  model?: string;
  content: ClaudeContentItem[] | string;
  stop_reason?: string;
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Tool definition from system init message.
 */
export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

/**
 * Plugin information from system init message.
 */
export interface PluginInfo {
  name: string;
  path: string;
}

// =============================================================================
// Initialize Response Metadata
// =============================================================================

/**
 * Slash command information returned in initialize response.
 */
export interface CommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
}

/**
 * Model option information returned in initialize response.
 */
export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
}

/**
 * Account information returned in initialize response.
 */
export interface AccountInfo {
  email: string;
  organization: string;
  subscriptionType: string;
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
 * Union of all request subtypes SDK can send to CLI.
 */
export type SdkToCliRequest = InitializeRequest | SetPermissionModeRequest | InterruptRequest;

// =============================================================================
// Control Response Types (SDK -> CLI)
// =============================================================================

/**
 * Response data to allow tool execution.
 */
export interface AllowResponseData {
  behavior: 'allow';
  updatedInput?: Record<string, unknown>;
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
 * Option for AskUserQuestion.
 */
export interface AskUserQuestionOption {
  label: string;
  description: string;
}

/**
 * Question in AskUserQuestion input.
 */
export interface AskUserQuestion {
  question: string;
  header?: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
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
 * Result message - final conversation result with usage stats.
 * Supports both camelCase and snake_case field names.
 */
export interface ResultMessage {
  type: 'result';
  subtype?: 'success' | 'error';
  // Session ID (both formats supported)
  session_id?: string;
  sessionId?: string;
  // Error flags (both formats supported)
  isError?: boolean;
  is_error?: boolean;
  // Duration (both formats supported)
  durationMs?: number;
  duration_ms?: number;
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
  | ControlCancelRequest;

/**
 * Union of all message types that SDK can send to CLI.
 */
export type SdkToCliMessage = SdkControlRequest | ControlResponse | UserMessageRequest;

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
 * Type guard to check if a content item is TextContent.
 */
export function isTextContent(item: ClaudeContentItem): item is TextContent {
  return item.type === 'text';
}

/**
 * Type guard to check if a content item is ThinkingContent.
 */
export function isThinkingContent(item: ClaudeContentItem): item is ThinkingContent {
  return item.type === 'thinking';
}

/**
 * Type guard to check if a content item is ToolUseContent.
 */
export function isToolUseContent(item: ClaudeContentItem): item is ToolUseContent {
  return item.type === 'tool_use';
}

/**
 * Type guard to check if a content item is ToolResultContent.
 */
export function isToolResultContent(item: ClaudeContentItem): item is ToolResultContent {
  return item.type === 'tool_result';
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
