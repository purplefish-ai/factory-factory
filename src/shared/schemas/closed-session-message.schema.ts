import { z } from 'zod';
import type { ChatMessage } from '@/shared/acp-protocol';
import { SessionLifecycleEventKind, SessionLifecycleEventReason } from '@/shared/core';
import { AttachmentSchema, ChatSettingsSchema } from '@/shared/websocket/chat-message.schema';

const text = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const image = z
  .object({
    type: z.literal('image'),
    source: z
      .object({ type: z.literal('base64'), data: z.string(), media_type: z.string() })
      .passthrough(),
  })
  .passthrough();
const toolUse = z
  .object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    // Streaming blocks legitimately precede their input deltas. Normalize only
    // the parsed renderer view; the archived JSON string/hash is never rewritten.
    input: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .passthrough();
const content = z.discriminatedUnion('type', [
  text,
  image,
  toolUse,
  z.object({ type: z.literal('thinking'), thinking: z.string() }).passthrough(),
  z
    .object({
      type: z.literal('tool_result'),
      tool_use_id: z.string(),
      content: z.union([z.string(), z.array(z.discriminatedUnion('type', [text, image]))]),
      is_error: z.boolean().optional(),
    })
    .passthrough(),
]);
const payload = z
  .object({
    role: z.enum(['assistant', 'user']),
    content: z.union([z.string(), z.array(content)]),
    id: z.string().optional(),
    type: z.string().optional(),
    model: z.string().optional(),
    stop_reason: z.string().optional(),
  })
  .passthrough();
const usage = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    service_tier: z.string().optional(),
  })
  .passthrough();
const delta = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_delta'), text: z.string() }).passthrough(),
  z.object({ type: z.literal('thinking_delta'), thinking: z.string() }).passthrough(),
  z.object({ type: z.literal('input_json_delta'), partial_json: z.string() }).passthrough(),
]);
const stream = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message_start'), message: payload }).passthrough(),
  z
    .object({
      type: z.literal('content_block_start'),
      index: z.number().int().nonnegative(),
      content_block: content,
    })
    .passthrough(),
  z
    .object({
      type: z.literal('content_block_delta'),
      index: z.number().int().nonnegative(),
      delta,
    })
    .passthrough(),
  z
    .object({ type: z.literal('content_block_stop'), index: z.number().int().nonnegative() })
    .passthrough(),
  z
    .object({
      type: z.literal('message_delta'),
      delta: z
        .object({ stop_reason: z.string().optional(), stop_sequence: z.string().optional() })
        .passthrough()
        .optional(),
      usage: usage.optional(),
    })
    .passthrough(),
  z.object({ type: z.literal('message_stop') }).passthrough(),
]);
const modelUsage = z
  .object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadInputTokens: z.number(),
    cacheCreationInputTokens: z.number(),
    webSearchRequests: z.number(),
    costUSD: z.number(),
    contextWindow: z.number(),
    maxOutputTokens: z.number(),
  })
  .passthrough();
const agent = z
  .object({
    timestamp: z.string().optional(),
    session_id: z.string().optional(),
    parent_tool_use_id: z.string().optional(),
    message: payload.optional(),
    event: stream.optional(),
    usage: usage.optional(),
    model_usage: z.record(z.string(), modelUsage).optional(),
    duration_ms: z.number().optional(),
    duration_api_ms: z.number().optional(),
    total_cost_usd: z.number().optional(),
    num_turns: z.number().optional(),
    is_error: z.boolean().optional(),
    error: z.string().optional(),
    result: z.unknown().optional(),
    subtype: z.string().optional(),
    tools: z
      .array(
        z
          .object({
            name: z.string(),
            description: z.string().optional(),
            input_schema: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough()
      )
      .optional(),
    model: z.string().optional(),
    cwd: z.string().optional(),
    apiKeySource: z.string().optional(),
    status: z.string().optional(),
    childWorkspaceId: z.string().optional(),
    childWorkspaceName: z.string().optional(),
    childProjectName: z.string().optional(),
    parentWorkspaceId: z.string().optional(),
    parentWorkspaceName: z.string().optional(),
    parentProjectName: z.string().optional(),
    text: z.string().optional(),
    prDeliveryState: z.enum(['queued', 'delivered', 'failed', 'cancelled']).optional(),
    lifecycle: z.never().optional(),
  })
  .passthrough();
const agentMessage = z.discriminatedUnion('type', [
  agent.extend({ type: z.enum(['assistant', 'user']), message: payload }),
  agent.extend({ type: z.literal('stream_event'), event: stream }),
  agent.extend({
    type: z.enum([
      'system',
      'result',
      'error',
      'child_workspace_update',
      'parent_workspace_update',
      'pr_update',
    ]),
  }),
  agent.extend({
    type: z.literal('session_lifecycle'),
    lifecycle: z
      .object({
        eventId: z.string(),
        kind: z.enum(SessionLifecycleEventKind),
        reason: z.enum(SessionLifecycleEventReason),
        message: z.string(),
        timestamp: z.string(),
      })
      .passthrough(),
  }),
]);

/** Validate every typed renderer field; preserve evolving JSON provenance as unknown. */
const chatMessage = z
  .object({
    id: z.string(),
    source: z.enum(['user', 'agent']),
    timestamp: z.string(),
    order: z.number(),
    text: z.string().optional(),
    providerPrompt: z
      .union([z.string(), z.array(content)])
      .nullable()
      .optional(),
    message: agentMessage.optional(),
    attachments: z.array(AttachmentSchema.passthrough()).optional(),
    settings: ChatSettingsSchema.partial().passthrough().optional(),
    subagentId: z.string().optional(),
    subagentIconIndex: z.number().optional(),
  })
  .passthrough();

export const persistedChatMessageSchema = z.discriminatedUnion('source', [
  chatMessage.extend({ source: z.literal('user') }),
  chatMessage.extend({ source: z.literal('agent'), message: agentMessage }),
]) satisfies z.ZodType<ChatMessage>;
