import { z } from 'zod';

export const workspaceMailKindSchema = z.enum([
  'MESSAGE',
  'PROGRESS',
  'BLOCKER',
  'QUESTION',
  'COMPLETION',
  'INSTRUCTION',
]);
export type WorkspaceMailKind = z.infer<typeof workspaceMailKindSchema>;
export const workspaceMailSendMetadataSchema = z.object({
  subject: z.string().trim().max(200).optional(),
  kind: workspaceMailKindSchema.optional(),
  taskKey: z.string().trim().min(1).max(200).optional(),
  taskRevision: z.number().int().nonnegative().optional(),
});
export type WorkspaceMailSendMetadata = z.infer<typeof workspaceMailSendMetadataSchema>;
const workspaceId = z.string().min(1);
const ids = z.array(z.string().min(1)).min(1).max(20);
export const listMailInputSchema = z.object({
  workspaceId,
  cursor: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(20),
  unreadOnly: z.boolean().optional(),
  includeSuperseded: z
    .boolean()
    .default(false)
    .describe(
      'Include retained superseded progress history; omitted by default to keep the inbox bounded to current progress.'
    ),
  kinds: z.array(workspaceMailKindSchema).min(1).max(6).optional(),
});
export const readMailInputSchema = z.object({
  workspaceId,
  ids,
  maxChars: z.number().int().min(1).max(16_384).default(8192),
  offset: z.number().int().nonnegative().default(0),
});
export const ackMailInputSchema = z.object({
  workspaceId,
  ids,
  throughRevision: z.number().int().nonnegative(),
});
export type ListMailInput = z.input<typeof listMailInputSchema>;
export type ReadMailInput = z.input<typeof readMailInputSchema>;
export type AckMailInput = z.input<typeof ackMailInputSchema>;
export const workspaceMailSummarySchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  subject: z.string().nullable(),
  preview: z.string().max(160),
  kind: workspaceMailKindSchema,
  taskKey: z.string().nullable(),
  taskRevision: z.number().int().nullable(),
  sourceWorkspaceId: z.string(),
  sourceWorkspaceName: z.string(),
  sourceProjectName: z.string(),
  createdAt: z.coerce.date(),
  readAt: z.coerce.date().nullable(),
  acknowledgedAt: z.coerce.date().nullable(),
  supersededAt: z.coerce.date().nullable(),
});
export type WorkspaceMailSummary = z.infer<typeof workspaceMailSummarySchema>;
export const listMailResultSchema = z.object({
  wakeAmbiguous: z.boolean().default(false),
  items: z.array(workspaceMailSummarySchema).max(50),
  nextCursor: z.number().int().positive().nullable(),
  revision: z.number().int().nonnegative(),
});
export type WorkspaceMailListResult = z.infer<typeof listMailResultSchema>;
export const readMailResultSchema = z
  .object({
    items: z
      .array(
        workspaceMailSummarySchema.extend({
          body: z.string().max(16_384),
          offset: z.number().int().nonnegative(),
          nextOffset: z.number().int().nonnegative().nullable(),
        })
      )
      .max(20),
    revision: z.number().int().nonnegative(),
  })
  .refine((value) => value.items.reduce((total, item) => total + item.body.length, 0) <= 16_384, {
    message: 'Total mail body text exceeds 16384 characters',
  });
export type WorkspaceMailReadResult = z.infer<typeof readMailResultSchema>;
export const ackMailResultSchema = z.object({
  acknowledged: z.number().int().nonnegative().max(20),
  revision: z.number().int().nonnegative(),
});
export interface WorkspaceMailWakeClaim {
  workspaceId: string;
  revision: number;
  claimId: string;
}
