import { z } from 'zod';
import type { ChatMessage } from '@/shared/acp-protocol';

// Validate the persisted envelope while retaining evolving provider message fields.
const messageEnvelope = z
  .object({
    id: z.string(),
    source: z.enum(['user', 'agent']),
    timestamp: z.string(),
    order: z.number(),
    text: z.string().optional(),
    message: z.object({ type: z.string() }).passthrough().optional(),
  })
  .passthrough();

export const closedSessionTranscriptSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  workspaceId: z.string(),
  metadata: z
    .object({
      name: z.string().nullable(),
      workflow: z.string(),
      provider: z.enum(['CLAUDE', 'CODEX']),
      codexAccountId: z.string().nullish(),
      providerSessionId: z.string().optional(),
      model: z.string(),
      startedAt: z.string(),
      completedAt: z.string(),
    })
    .passthrough(),
  messages: z.array(z.custom<ChatMessage>((value) => messageEnvelope.safeParse(value).success)),
});
