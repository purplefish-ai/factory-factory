import { z } from 'zod';
import { AttachmentSchema, ChatSettingsSchema } from '@/shared/websocket/chat-message.schema';

// Extracted verbatim from the session owner's submittedSchema. Field order and
// normal Zod object stripping are part of the existing fingerprint contract.
export const submittedIntentSchema = z.object({
  id: z.string(),
  text: z.string(),
  timestamp: z.string(),
  attachments: z.array(AttachmentSchema).optional(),
  voiceMode: z.boolean().optional(),
  settings: ChatSettingsSchema,
});
export const intentSettingsSchema = ChatSettingsSchema;

function frozenJson<T>(schema: z.ZodType<T>, label: string) {
  return z.json().superRefine((original, ctx) => {
    const parsed = schema.safeParse(original);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: 'custom', path: issue.path, message: `${label}: ${issue.message}` });
      }
    }
  });
}

// Validate with the same owner decoder while retaining original evidence JSON.
// Returning the parsed object would silently strip evolving provenance fields.
export const frozenSubmittedIntentSchema = frozenJson(
  submittedIntentSchema,
  'Invalid submitted intent'
);
export const frozenIntentSettingsSchema = frozenJson(
  intentSettingsSchema,
  'Invalid intent settings'
);
