import { z } from 'zod';
import { SessionLifecycleEventKind, SessionLifecycleEventReason } from '@/shared/core';
import { AttachmentSchema } from '@/shared/websocket/chat-message.schema';
import {
  ArchivedJsonValueSchema,
  ArchivedMessageContentSchema,
  ArchivedModelUsageRecordSchema,
  ArchivedStreamEventSchema,
  ArchivedToolDefinitionSchema,
  ArchivedUsageSchema,
} from './archived-content-schema';
import type { AgentMessage, ChatMessage } from './messages';

const commonFields = {
  prDeliveryState: z.enum(['queued', 'delivered', 'failed', 'cancelled']).optional(),
  timestamp: z.string().optional(),
  childWorkspaceId: z.string().optional(),
  childWorkspaceName: z.string().optional(),
  childProjectName: z.string().optional(),
  parentWorkspaceId: z.string().optional(),
  parentWorkspaceName: z.string().optional(),
  parentProjectName: z.string().optional(),
  text: z.string().optional(),
  session_id: z.string().optional(),
  parent_tool_use_id: z.string().optional(),
  message: z
    .object({ role: z.enum(['assistant', 'user']), content: ArchivedMessageContentSchema })
    .optional(),
  event: ArchivedStreamEventSchema.optional(),
  usage: ArchivedUsageSchema.optional(),
  duration_ms: z.number().optional(),
  duration_api_ms: z.number().optional(),
  total_cost_usd: z.number().optional(),
  num_turns: z.number().optional(),
  is_error: z.boolean().optional(),
  error: z.string().optional(),
  result: ArchivedJsonValueSchema.optional(),
  model_usage: ArchivedModelUsageRecordSchema.optional(),
  subtype: z.string().optional(),
  tools: z.array(ArchivedToolDefinitionSchema).optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  apiKeySource: z.string().optional(),
  status: z.string().optional(),
};

/** Complete current serialized rows for archive readers; does not alter live acceptance. */
export const ArchivedAgentMessageSchema = z.discriminatedUnion('type', [
  z.object({
    ...commonFields,
    type: z.literal('session_lifecycle'),
    lifecycle: z.object({
      eventId: z.string(),
      kind: z.enum(SessionLifecycleEventKind),
      reason: z.enum(SessionLifecycleEventReason),
      message: z.string(),
      timestamp: z.string(),
    }),
  }),
  z.object({
    ...commonFields,
    type: z.enum([
      'system',
      'assistant',
      'user',
      'stream_event',
      'result',
      'error',
      'child_workspace_update',
      'parent_workspace_update',
      'pr_update',
    ]),
    lifecycle: z.never().optional(),
  }),
]) satisfies z.ZodType<AgentMessage>;

/** Unknown tags and invalid current rows are left to the future legacy archive adapter. */
export const ArchivedChatMessageSchema = z.object({
  subagentId: z.string().optional(),
  subagentIconIndex: z.number().optional(),
  id: z.string(),
  source: z.enum(['user', 'agent']),
  text: z.string().optional(),
  message: ArchivedAgentMessageSchema.optional(),
  timestamp: z.string(),
  attachments: z.array(AttachmentSchema).optional(),
  order: z.number(),
}) satisfies z.ZodType<ChatMessage>;
