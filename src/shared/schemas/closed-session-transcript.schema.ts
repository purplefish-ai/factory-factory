import { z } from 'zod';
import { persistedChatMessageSchema } from './closed-session-message.schema';

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
  messages: z.array(persistedChatMessageSchema),
});
