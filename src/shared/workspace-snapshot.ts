import { z } from 'zod';
import {
  CIStatus,
  KanbanColumn,
  PRState,
  RatchetState,
  RunScriptStatus,
  SessionProvider,
  SessionStatus,
  WORKSPACE_SIDEBAR_ACTIVITY_STATES,
  WORKSPACE_SIDEBAR_CI_STATES,
  WorkspaceStatus,
} from '@/shared/core';
import {
  SESSION_RUNTIME_ACTIVITIES,
  SESSION_RUNTIME_PHASES,
  SESSION_RUNTIME_PROCESS_STATES,
} from '@/shared/session-runtime';
import { WORKSPACE_CI_OBSERVATIONS, WORKSPACE_FLOW_PHASES } from '@/shared/workspace-flow-state';
import {
  WORKSPACE_PENDING_REQUEST_TYPES,
  WORKSPACE_STATUS_REASON_CODES,
  WORKSPACE_STATUS_REASON_TONES,
} from '@/shared/workspace-status-reason';

const SnapshotFieldGroupSchema = z.enum([
  'workspace',
  'pr',
  'session',
  'ratchet',
  'runScript',
  'reconciliation',
]);

export type SnapshotFieldGroup = z.infer<typeof SnapshotFieldGroupSchema>;

const SessionRuntimeLastExitSchema = z.object({
  code: z.number().nullable(),
  timestamp: z.string(),
  unexpected: z.boolean(),
});

const WorkspaceSessionSummarySchema = z.object({
  sessionId: z.string(),
  name: z.string().nullable(),
  workflow: z.string().nullable(),
  model: z.string().nullable(),
  provider: z.nativeEnum(SessionProvider).optional(),
  persistedStatus: z.nativeEnum(SessionStatus),
  runtimePhase: z.enum(SESSION_RUNTIME_PHASES),
  processState: z.enum(SESSION_RUNTIME_PROCESS_STATES),
  activity: z.enum(SESSION_RUNTIME_ACTIVITIES),
  updatedAt: z.string(),
  lastExit: SessionRuntimeLastExitSchema.nullable(),
  errorMessage: z.string().nullable().optional(),
});

const WorkspaceGitStatsSchema = z.object({
  total: z.number(),
  additions: z.number(),
  deletions: z.number(),
  hasUncommitted: z.boolean(),
});

const WorkspaceSidebarStatusSchema = z.object({
  activityState: z.enum(WORKSPACE_SIDEBAR_ACTIVITY_STATES),
  ciState: z.enum(WORKSPACE_SIDEBAR_CI_STATES),
});

const WorkspaceStatusReasonSchema = z.object({
  code: z.enum(WORKSPACE_STATUS_REASON_CODES),
  label: z.string(),
  tone: z.enum(WORKSPACE_STATUS_REASON_TONES),
  needsUser: z.boolean(),
});

const RatchetDispatchOutcomeSchema = z.enum(['RUNNING', 'COMPLETED', 'DIED']);

export const WorkspaceSnapshotEntrySchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  version: z.number(),
  computedAt: z.string(),
  source: z.string(),
  name: z.string(),
  status: z.nativeEnum(WorkspaceStatus),
  createdAt: z.string(),
  branchName: z.string().nullable(),
  prUrl: z.string().nullable(),
  prNumber: z.number().nullable(),
  prState: z.nativeEnum(PRState),
  prCiStatus: z.nativeEnum(CIStatus),
  prUpdatedAt: z.string().nullable(),
  ratchetEnabled: z.boolean(),
  ratchetState: z.nativeEnum(RatchetState),
  ratchetDispatchOutcome: RatchetDispatchOutcomeSchema.nullable(),
  ratchetDispatchRetryCount: z.number().int().nonnegative(),
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
  }),
});

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
