import { z } from 'zod';
import {
  CIStatus,
  KanbanColumn,
  PRState,
  RatchetState,
  RunScriptStatus,
  WorkspaceStatus,
} from '@/shared/core';
import { WORKSPACE_CI_OBSERVATIONS, WORKSPACE_FLOW_PHASES } from '@/shared/workspace-flow-state';
import { WORKSPACE_PENDING_REQUEST_TYPES } from '@/shared/workspace-status-reason';
import {
  WorkspaceSessionSummarySchema,
  WorkspaceGitStatsSchema,
  WorkspaceSidebarStatusSchema,
  WorkspaceStatusReasonSchema,
  WorkspaceSummarySchema,
} from '@/shared/workspace-summary';
import { prDeliveryModeSchema } from './schemas/pr-event.schema';
import { WorkspacePullRequestSchema } from './workspace-pr';
import { WorkspacePRSummarySchema } from './workspace-pr-summary';

const SnapshotFieldGroupSchema = z.enum([
  'workspace',
  'pr',
  'session',
  'ratchet',
  'runScript',
  'reconciliation',
  'git',
  'metadata',
]);

export type SnapshotFieldGroup = z.infer<typeof SnapshotFieldGroupSchema>;

export const WorkspaceSnapshotMetadataSchema = WorkspaceSummarySchema.pick({
  defaultSessionProvider: true,
  worktreePath: true,
  initErrorMessage: true,
  githubIssueNumber: true,
  githubIssueUrl: true,
  linearIssueId: true,
  linearIssueIdentifier: true,
  linearIssueUrl: true,
  creationSource: true,
});
export type WorkspaceSnapshotMetadata = z.infer<typeof WorkspaceSnapshotMetadataSchema>;

const snapshotMetadataFields = WorkspaceSnapshotMetadataSchema.partial();
/** Preserve only supplied metadata; unknown nullable fields remain absent. */
export function projectWorkspaceSnapshotMetadata(source: Partial<WorkspaceSnapshotMetadata>) {
  return snapshotMetadataFields.parse(source);
}

const SnapshotEntrySchema = z.object({
  ...WorkspaceSnapshotMetadataSchema.partial().shape,
  workspaceId: z.string(),
  projectId: z.string(),
  version: z.number(),
  computedAt: z.string(),
  source: z.string(),
  name: z.string(),
  status: z.nativeEnum(WorkspaceStatus),
  createdAt: z.string(),
  branchName: z.string().nullable(),
  prs: z.array(WorkspacePullRequestSchema).optional(),
  prSummary: WorkspacePRSummarySchema.optional(),
  prUrl: z.string().nullable(),
  prNumber: z.number().nullable(),
  prState: z.nativeEnum(PRState),
  prCiStatus: z.nativeEnum(CIStatus),
  prUpdatedAt: z.string().nullable(),
  hasMergeConflict: z.boolean(),
  ratchetEnabled: z.boolean(),
  ratchetState: z.nativeEnum(RatchetState),
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
  runScriptStatus: z.nativeEnum(RunScriptStatus),
  hasHadSessions: z.boolean(),
  isWorking: z.boolean(),
  pendingRequestType: z.enum(WORKSPACE_PENDING_REQUEST_TYPES).nullable(),
  sessionSummaries: z.array(WorkspaceSessionSummarySchema),
  gitStats: WorkspaceGitStatsSchema.nullable(),
  lastActivityAt: z.string().nullable(),
  sidebarStatus: WorkspaceSidebarStatusSchema,
  kanbanColumn: z.nativeEnum(KanbanColumn).nullable(),
  flowPhase: z.enum(WORKSPACE_FLOW_PHASES),
  ciObservation: z.enum(WORKSPACE_CI_OBSERVATIONS),
  ratchetButtonAnimated: z.boolean(),
  statusReason: WorkspaceStatusReasonSchema,
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

export const SnapshotServerMessageSchema = z.discriminatedUnion('type', [
  SnapshotFullMessageSchema,
  SnapshotChangedMessageSchema,
  SnapshotRemovedMessageSchema,
]);

export type SnapshotFullMessage = z.infer<typeof SnapshotFullMessageSchema>;
export type SnapshotChangedMessage = z.infer<typeof SnapshotChangedMessageSchema>;
export type SnapshotRemovedMessage = z.infer<typeof SnapshotRemovedMessageSchema>;
export type SnapshotServerMessage = z.infer<typeof SnapshotServerMessageSchema>;
