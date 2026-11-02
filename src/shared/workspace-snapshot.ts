import { z } from 'zod';
import { WorkspaceSummarySchema } from '@/shared/workspace-summary';
import { prDeliveryModeSchema } from './schemas/pr-event.schema';
import { WorkspacePullRequestSchema } from './workspace-pr';
import { WorkspacePRSummarySchema } from './workspace-pr-summary';
import { snapshotMetadataMask } from './workspace-projection-fields';

export type { SnapshotFieldGroup } from './workspace-projection-fields';

export const WorkspaceSnapshotMetadataSchema = WorkspaceSummarySchema.pick(snapshotMetadataMask);
export type WorkspaceSnapshotMetadata = z.infer<typeof WorkspaceSnapshotMetadataSchema>;

const snapshotMetadataFields = WorkspaceSnapshotMetadataSchema.partial();
/** Preserve only supplied metadata; unknown nullable fields remain absent. */
export function projectWorkspaceSnapshotMetadata(source: Partial<WorkspaceSnapshotMetadata>) {
  return snapshotMetadataFields.parse(source);
}

const SnapshotEntrySchema = z.object({
  ...WorkspaceSummarySchema.omit({ id: true, ...snapshotMetadataMask }).shape,
  ...WorkspaceSnapshotMetadataSchema.partial().shape,
  workspaceId: z.string(),
  version: z.number(),
  computedAt: z.string(),
  source: z.string(),
  createdAt: z.string(),
  prs: z.array(WorkspacePullRequestSchema).optional(),
  prSummary: WorkspacePRSummarySchema.optional(),
  prUpdatedAt: z.string().nullable(),
  hasMergeConflict: z.boolean(),
  prMonitoring: z
    .object({
      enabled: z.boolean(),
      deliveryMode: prDeliveryModeSchema.default('MAIN'),
      recipientSessionId: z.string().nullable(),
      bindingRevision: z.number().int().nonnegative(),
      pauseReason: z.string().nullable(),
      pendingEventCount: z.number().int().nonnegative(),
    })
    .default({
      enabled: false,
      deliveryMode: 'MAIN',
      recipientSessionId: null,
      bindingRevision: 0,
      pauseReason: null,
      pendingEventCount: 0,
    }),
  hasHadSessions: z.boolean(),
  fieldTimestamps: z.object({
    workspace: z.number(),
    pr: z.number(),
    session: z.number(),
    ratchet: z.number(),
    runScript: z.number(),
    reconciliation: z.number(),
    git: z.number().optional(),
    metadata: z.number().optional(),
  }),
});

// The complete branch validates before legacy defaults are applied: a version
// claim cannot turn an omitted nullable field into known authoritative data.
const CompleteSnapshotEntrySchema = SnapshotEntrySchema.extend({
  ...WorkspaceSnapshotMetadataSchema.shape,
  summaryVersion: z.literal(1),
  prs: z.array(WorkspacePullRequestSchema),
  prSummary: WorkspacePRSummarySchema,
  prMonitoring: WorkspaceSummarySchema.shape.prMonitoring,
}).superRefine((entry, context) => {
  const result = WorkspaceSummarySchema.safeParse({ ...entry, id: entry.workspaceId });
  if (!result.success) {
    for (const issue of result.error.issues) {
      context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
  }
});

export const WorkspaceSnapshotEntrySchema = z.union([
  CompleteSnapshotEntrySchema,
  SnapshotEntrySchema.extend({ summaryVersion: z.undefined().optional() }),
]);
export type WorkspaceSnapshotEntry = z.infer<typeof WorkspaceSnapshotEntrySchema>;

export const SnapshotFullMessageSchema = z.object({
  type: z.literal('snapshot_full'),
  projectId: z.string(),
  entries: z.array(WorkspaceSnapshotEntrySchema),
  reviewCount: z.number().int().nonnegative().optional(),
});

export const SnapshotChangedMessageSchema = z.object({
  type: z.literal('snapshot_changed'),
  workspaceId: z.string(),
  entry: WorkspaceSnapshotEntrySchema,
  reviewCount: z.number().int().nonnegative().optional(),
});

export const SnapshotRemovedMessageSchema = z.object({
  type: z.literal('snapshot_removed'),
  workspaceId: z.string(),
  reviewCount: z.number().int().nonnegative().optional(),
});

export const SnapshotErrorMessageSchema = z.object({
  type: z.literal('snapshot_error'),
  projectId: z.string().optional(),
  code: z.literal('FRAME_TOO_LARGE'),
  message: z.string().max(512),
});

export const SnapshotServerMessageSchema = z.discriminatedUnion('type', [
  SnapshotFullMessageSchema,
  SnapshotChangedMessageSchema,
  SnapshotRemovedMessageSchema,
  SnapshotErrorMessageSchema,
]);

export type SnapshotFullMessage = z.infer<typeof SnapshotFullMessageSchema>;
export type SnapshotChangedMessage = z.infer<typeof SnapshotChangedMessageSchema>;
export type SnapshotRemovedMessage = z.infer<typeof SnapshotRemovedMessageSchema>;
export type SnapshotServerMessage = z.infer<typeof SnapshotServerMessageSchema>;
