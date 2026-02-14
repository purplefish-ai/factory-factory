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
 * Tool use content block - agent requesting to use a tool.
 */
export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

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
 * Image content block for user messages (base64 encoded).
 * Used when users upload images in chat.
 */
export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

/**
 * Value type for tool_result content field.
 */
export type ToolResultContentValue = string | Array<TextItem | ImageItem>;

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
export type AgentContentItem =
  | TextContent
  | ThinkingContent
  | ToolUseContent
  | ToolResultContent
  | ImageContent;

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
 * Delta for tool input JSON streaming.
 */
export interface InputJsonDelta {
  type: 'input_json_delta';
  partial_json: string;
}

/**
 * Union of content block delta types.
 */
export type ContentBlockDelta = TextDelta | ThinkingDelta | InputJsonDelta;

/**
 * Token usage statistics.
 */
export interface AgentUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  service_tier?: string;
}

/**
 * Model-specific usage statistics from the SDK.
 * This matches the modelUsage/model_usage field in ResultMessage.
 */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

/**
 * Agent message within a stream event.
 */
export interface AgentMessagePayload {
  id?: string;
  type?: string;
  role: 'assistant' | 'user';
  model?: string;
  content: AgentContentItem[] | string;
  stop_reason?: string;
}

/**
 * Stream event types from the ACP runtime.
 */
export type AgentStreamEvent =
  | { type: 'message_start'; message: AgentMessagePayload }
  | { type: 'content_block_start'; index: number; content_block: AgentContentItem }
  | { type: 'content_block_delta'; index: number; delta: ContentBlockDelta }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta?: { stop_reason?: string; stop_sequence?: string };
      usage?: AgentUsage;
    }
  | { type: 'message_stop' };

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

/**
 * Session initialization data from system init message.
 * Stores information about the session's available tools, model, etc.
 */
export interface SessionInitData {
  tools: ToolDefinition[];
  model: string | null;
  cwd: string | null;
  apiKeySource: string | null;
  slashCommands: string[];
  plugins: PluginInfo[];
}

/**
 * Information about an active hook.
 */
export interface ActiveHookInfo {
  hookId: string;
  hookName: string;
  hookEvent: string;
  startedAt: string;
}
