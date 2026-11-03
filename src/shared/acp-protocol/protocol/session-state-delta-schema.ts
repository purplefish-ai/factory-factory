import { z } from 'zod';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import { prDeliveryRequestSchema } from '@/shared/schemas/pr-event.schema';
import { AttachmentSchema, ChatSettingsSchema } from '@/shared/websocket/chat-message.schema';
import { ArchivedChatMessageSchema } from './archived-message-schema';
import type { QueuedMessage } from './queued';

/**
 * Wire schemas for the targeted session-state deltas that replace full
 * `session_snapshot` broadcasts for queue, commit, and interactive-request
 * changes. Each delta carries only the state it changes.
 */

const QueuedMessageWireSchema = z.object({
  source: z.object({ type: z.literal('pr_event'), request: prDeliveryRequestSchema }).optional(),
  id: z.string(),
  text: z.string(),
  timestamp: z.string(),
  attachments: z.array(AttachmentSchema).optional(),
  voiceMode: z.boolean().optional(),
  settings: ChatSettingsSchema,
}) satisfies z.ZodType<QueuedMessage>;

const AcpPermissionOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
});

const PendingInteractiveRequestWireSchema = z.object({
  requestId: z.string(),
  toolName: z.string(),
  rawToolName: z.string().optional(),
  toolUseId: z.string(),
  input: z.record(z.string(), z.unknown()),
  elicitation: z.enum(['form', 'url']).optional(),
  planContent: z.string().nullable(),
  acpOptions: z.array(AcpPermissionOptionSchema).optional(),
  timestamp: z.string(),
}) satisfies z.ZodType<PendingInteractiveRequest>;

/** Complete authoritative queue after an enqueue, removal, dequeue, or requeue. */
const QueueUpdatedDeltaSchema = z.object({
  type: z.literal('queue_updated'),
  queuedMessages: z.array(QueuedMessageWireSchema),
});

/** Current pending interactive request, or null after it is resolved or cleared. */
const PendingRequestUpdatedDeltaSchema = z.object({
  type: z.literal('pending_request_updated'),
  pendingInteractiveRequest: PendingInteractiveRequestWireSchema.nullable(),
});

/** One committed transcript entry together with the queue that remains after it. */
const TranscriptMessageCommittedDeltaSchema = z.object({
  type: z.literal('transcript_message_committed'),
  chatMessage: ArchivedChatMessageSchema,
  queuedMessages: z.array(QueuedMessageWireSchema),
});

const SESSION_STATE_DELTA_SCHEMAS = {
  queue_updated: QueueUpdatedDeltaSchema,
  pending_request_updated: PendingRequestUpdatedDeltaSchema,
  transcript_message_committed: TranscriptMessageCommittedDeltaSchema,
} as const;

type SessionStateDeltaType = keyof typeof SESSION_STATE_DELTA_SCHEMAS;

function isSessionStateDeltaType(type: string): type is SessionStateDeltaType {
  return Object.hasOwn(SESSION_STATE_DELTA_SCHEMAS, type);
}

/**
 * Validates a targeted session-state delta. Returns null when `type` is not one
 * of these deltas, so callers can apply their other checks.
 */
export function validateSessionStateDelta(type: string, data: unknown): boolean | null {
  if (!isSessionStateDeltaType(type)) {
    return null;
  }
  return SESSION_STATE_DELTA_SCHEMAS[type].safeParse(data).success;
}
