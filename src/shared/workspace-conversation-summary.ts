import { z } from 'zod';

export const WorkspaceMetadataResultSchema = z.object({
  title: z.string().trim().min(1).max(100),
  branch: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  summary: z.string().trim().min(1).max(500),
  sidebarSummary: z.string().trim().min(1).max(120),
});
export type WorkspaceMetadataResult = z.infer<typeof WorkspaceMetadataResultSchema>;

export const WorkspaceConversationSummarySchema = WorkspaceMetadataResultSchema.extend({
  generatedAt: z.string().datetime(),
  sourceSessionId: z.string(),
  sourceMessageId: z.string(),
});
export type WorkspaceConversationSummary = z.infer<typeof WorkspaceConversationSummarySchema>;
