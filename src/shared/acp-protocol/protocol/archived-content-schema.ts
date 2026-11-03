import { z } from 'zod';

const TextSchema = z.object({ type: z.literal('text'), text: z.string() });
const ImageSchema = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.literal('base64'),
    data: z.string(),
    media_type: z.string(),
  }),
});

// Validate entries before reconstruction: z.record/z.json drop own __proto__ keys.
const JsonEntriesSchema = z.unknown().transform((value, ctx) => {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    ctx.issues.push({ code: 'custom', message: 'Expected a JSON object', input: value });
    return z.NEVER;
  }
  const entries: [string, unknown][] = Object.entries(value);
  return entries;
});

// Archives contain serialized JSON, not arbitrary runtime values hidden in unknown fields.
export const ArchivedJsonValueSchema: z.ZodType<z.infer<ReturnType<typeof z.json>>> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(ArchivedJsonValueSchema),
    ArchivedJsonRecordSchema,
  ])
);
export const ArchivedJsonRecordSchema = JsonEntriesSchema.pipe(
  z.array(z.tuple([z.string(), ArchivedJsonValueSchema]))
).transform((entries) => Object.fromEntries(entries));

export const ArchivedContentItemSchema = z.discriminatedUnion('type', [
  TextSchema,
  z.object({ type: z.literal('thinking'), thinking: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: ArchivedJsonRecordSchema,
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.union([
      z.string(),
      z.array(z.discriminatedUnion('type', [TextSchema, ImageSchema])),
    ]),
    is_error: z.boolean().optional(),
  }),
  ImageSchema,
]);

export const ArchivedMessageContentSchema = z.union([
  z.string(),
  z.array(ArchivedContentItemSchema),
]);

export const ArchivedUsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  service_tier: z.string().optional(),
});

export const ArchivedModelUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  webSearchRequests: z.number(),
  costUSD: z.number(),
  contextWindow: z.number(),
  maxOutputTokens: z.number(),
});

export const ArchivedModelUsageRecordSchema = JsonEntriesSchema.pipe(
  z.array(z.tuple([z.string(), ArchivedModelUsageSchema]))
).transform((entries) => Object.fromEntries(entries));

export const ArchivedToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: ArchivedJsonRecordSchema.optional(),
});

export const ArchivedStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message_start'),
    message: z.object({
      id: z.string().optional(),
      type: z.string().optional(),
      role: z.enum(['assistant', 'user']),
      model: z.string().optional(),
      content: ArchivedMessageContentSchema,
      stop_reason: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal('content_block_start'),
    index: z.number(),
    content_block: ArchivedContentItemSchema,
  }),
  z.object({
    type: z.literal('content_block_delta'),
    index: z.number(),
    delta: z.discriminatedUnion('type', [
      z.object({ type: z.literal('text_delta'), text: z.string() }),
      z.object({ type: z.literal('thinking_delta'), thinking: z.string() }),
      z.object({ type: z.literal('input_json_delta'), partial_json: z.string() }),
    ]),
  }),
  z.object({ type: z.literal('content_block_stop'), index: z.number() }),
  z.object({
    type: z.literal('message_delta'),
    delta: z
      .object({ stop_reason: z.string().optional(), stop_sequence: z.string().optional() })
      .optional(),
    usage: ArchivedUsageSchema.optional(),
  }),
  z.object({ type: z.literal('message_stop') }),
]);
