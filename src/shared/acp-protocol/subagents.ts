import { z } from 'zod';

export const SUBAGENTS_CAPABILITY_META_KEY = 'factoryfactory.ai/subagents';
export const SUBAGENT_TOOL_META_KEY = 'factoryfactory.ai/subagent';
export const SUBAGENTS_LIST_METHOD = 'factoryfactory.ai/subagents/list';
export const SUBAGENTS_READ_METHOD = 'factoryfactory.ai/subagents/read';
export const SUBAGENTS_CHANGED_METHOD = 'factoryfactory.ai/subagents/changed';

const metaSchema = z.record(z.string(), z.unknown()).nullable().optional();

const annotationsSchema = z
  .object({
    _meta: metaSchema,
    audience: z
      .array(z.enum(['assistant', 'user']))
      .nullable()
      .optional(),
    lastModified: z.string().nullable().optional(),
    priority: z.number().nullable().optional(),
  })
  .passthrough();

const textResourceContentsSchema = z
  .object({
    _meta: metaSchema,
    mimeType: z.string().nullable().optional(),
    text: z.string(),
    uri: z.string(),
  })
  .passthrough();

const blobResourceContentsSchema = z
  .object({
    _meta: metaSchema,
    blob: z.string(),
    mimeType: z.string().nullable().optional(),
    uri: z.string(),
  })
  .passthrough();

const contentBlockSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('text'),
      _meta: metaSchema,
      annotations: annotationsSchema.nullable().optional(),
      text: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('image'),
      _meta: metaSchema,
      annotations: annotationsSchema.nullable().optional(),
      data: z.string(),
      mimeType: z.string(),
      uri: z.string().nullable().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('audio'),
      _meta: metaSchema,
      annotations: annotationsSchema.nullable().optional(),
      data: z.string(),
      mimeType: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('resource_link'),
      _meta: metaSchema,
      annotations: annotationsSchema.nullable().optional(),
      description: z.string().nullable().optional(),
      mimeType: z.string().nullable().optional(),
      name: z.string(),
      size: z.number().nullable().optional(),
      title: z.string().nullable().optional(),
      uri: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('resource'),
      _meta: metaSchema,
      annotations: annotationsSchema.nullable().optional(),
      resource: z.union([textResourceContentsSchema, blobResourceContentsSchema]),
    })
    .passthrough(),
]);

const toolKindSchema = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);

const toolCallStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed']);

const toolCallLocationSchema = z
  .object({
    _meta: metaSchema,
    line: z.number().int().nonnegative().nullable().optional(),
    path: z.string(),
  })
  .passthrough();

const toolCallContentSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('content'),
      _meta: metaSchema,
      content: contentBlockSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal('diff'),
      _meta: metaSchema,
      newText: z.string(),
      oldText: z.string().nullable().optional(),
      path: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('terminal'),
      _meta: metaSchema,
      terminalId: z.string(),
    })
    .passthrough(),
]);

const contentChunkFields = {
  _meta: metaSchema,
  content: contentBlockSchema,
  messageId: z.string().nullable().optional(),
};

const planEntrySchema = z
  .object({
    _meta: metaSchema,
    content: z.string(),
    priority: z.enum(['high', 'medium', 'low']),
    status: z.enum(['pending', 'in_progress', 'completed']),
  })
  .passthrough();

export const subagentTranscriptUpdateSchema = z.discriminatedUnion('sessionUpdate', [
  z.object({ sessionUpdate: z.literal('user_message_chunk'), ...contentChunkFields }).passthrough(),
  z
    .object({ sessionUpdate: z.literal('agent_message_chunk'), ...contentChunkFields })
    .passthrough(),
  z
    .object({ sessionUpdate: z.literal('agent_thought_chunk'), ...contentChunkFields })
    .passthrough(),
  z
    .object({
      sessionUpdate: z.literal('tool_call'),
      _meta: metaSchema,
      content: z.array(toolCallContentSchema).optional(),
      kind: toolKindSchema.optional(),
      locations: z.array(toolCallLocationSchema).optional(),
      rawInput: z.unknown().optional(),
      rawOutput: z.unknown().optional(),
      status: toolCallStatusSchema.optional(),
      title: z.string().min(1),
      toolCallId: z.string().min(1),
    })
    .passthrough(),
  z
    .object({
      sessionUpdate: z.literal('tool_call_update'),
      _meta: metaSchema,
      content: z.array(toolCallContentSchema).nullable().optional(),
      kind: toolKindSchema.nullable().optional(),
      locations: z.array(toolCallLocationSchema).nullable().optional(),
      rawInput: z.unknown().optional(),
      rawOutput: z.unknown().optional(),
      status: toolCallStatusSchema.nullable().optional(),
      title: z.string().nullable().optional(),
      toolCallId: z.string().min(1),
    })
    .passthrough(),
  z
    .object({
      sessionUpdate: z.literal('plan'),
      _meta: metaSchema,
      entries: z.array(planEntrySchema),
    })
    .passthrough(),
]);

export const subagentBrowseCapabilitySchema = z
  .object({
    version: z.literal(1),
    list: z.literal(true),
    read: z.literal(true),
    notifications: z.literal(true),
  })
  .passthrough();

export const subagentStatusSchema = z.enum([
  'starting',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

export const subagentSummarySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().nullable(),
    status: subagentStatusSchema,
    createdAt: z.string().datetime({ offset: true }).nullable(),
    updatedAt: z.string().datetime({ offset: true }).nullable(),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    latestActivity: z.string().nullable(),
    resultPreview: z.string().nullable(),
  })
  .passthrough();

const cursorSchema = z.string().min(1).nullish();
const nextCursorSchema = z.string().min(1).nullable();

export const subagentListParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    cursor: cursorSchema,
    limit: z.number().int().min(1).max(100).default(50),
  })
  .passthrough();

export const subagentListResultSchema = z
  .object({
    subagents: z.array(subagentSummarySchema),
    nextCursor: nextCursorSchema,
  })
  .passthrough();

export const subagentReadParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    subagentId: z.string().min(1),
    cursor: cursorSchema,
    limit: z.number().int().min(1).max(100).default(10),
  })
  .passthrough();

export const subagentReadResultSchema = z
  .object({
    updates: z.array(subagentTranscriptUpdateSchema),
    nextCursor: nextCursorSchema,
  })
  .passthrough();

export const subagentsChangedParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    subagentId: z.string().min(1),
    change: z.enum(['created', 'updated', 'completed']),
  })
  .passthrough();

export type SubagentBrowseCapability = z.infer<typeof subagentBrowseCapabilitySchema>;
export type SubagentStatus = z.infer<typeof subagentStatusSchema>;
export type SubagentSummary = z.infer<typeof subagentSummarySchema>;
export type SubagentTranscriptUpdate = z.infer<typeof subagentTranscriptUpdateSchema>;
export type SubagentListParams = z.infer<typeof subagentListParamsSchema>;
export type SubagentListResult = z.infer<typeof subagentListResultSchema>;
export type SubagentReadParams = z.infer<typeof subagentReadParamsSchema>;
export type SubagentReadResult = z.infer<typeof subagentReadResultSchema>;
export type SubagentsChangedParams = z.infer<typeof subagentsChangedParamsSchema>;
