import { z } from 'zod';
import { sessionLaunchSettingsSchema } from '@/shared/session-launch';

const providerDraftSchema = sessionLaunchSettingsSchema.extend({
  model: z.string().optional(),
  codexAccountId: z.string().optional(),
});
export const sessionLaunchSelectionSnapshotSchema = z.object({
  provider: z.enum(['CLAUDE', 'CODEX']).optional(),
  defaults: z
    .object({
      defaultSessionProvider: z.enum(['CLAUDE', 'CODEX']),
      defaultWorkspacePermissions: z.enum(['STRICT', 'RELAXED', 'YOLO']).optional(),
      defaultClaudeModel: z.string().optional(),
      defaultCodexModel: z.string().optional(),
      defaultClaudeReasoningEffort: z.string().nullable().optional(),
      defaultCodexReasoningEffort: z.string().nullable().optional(),
    })
    .optional(),
  drafts: z.object({
    CLAUDE: providerDraftSchema.optional(),
    CODEX: providerDraftSchema.optional(),
  }),
});
export type SessionLaunchSelectionSnapshot = z.infer<typeof sessionLaunchSelectionSnapshotSchema>;
