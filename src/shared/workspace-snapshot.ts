import { z } from 'zod';
import {
  CIStatus,
  KanbanColumn,
  PRState,
  RatchetState,
  RunScriptStatus,
  SessionProvider,
  SessionStatus,
  WorkspaceStatus,
} from '@/shared/core';
import type { WorkspaceCiObservation, WorkspaceFlowPhase } from '@/shared/workspace-flow-state';
import type {
  WorkspaceStatusReasonCode,
  WorkspaceStatusReasonTone,
} from '@/shared/workspace-status-reason';

const WORKSPACE_FLOW_PHASES = [
  'NO_PR',
  'CI_WAIT',
  'RATCHET_VERIFY',
  'RATCHET_FIXING',
  'READY',
  'MERGED',
] as const satisfies readonly WorkspaceFlowPhase[];

const WORKSPACE_CI_OBSERVATIONS = [
  'NOT_FETCHED',
  'NO_CHECKS',
  'CHECKS_PENDING',
  'CHECKS_FAILED',
  'CHECKS_PASSED',
  'CHECKS_UNKNOWN',
] as const satisfies readonly WorkspaceCiObservation[];

const WORKSPACE_STATUS_REASON_CODES = [
  'NEEDS_PERMISSION',
  'NEEDS_PLAN_APPROVAL',
  'NEEDS_ANSWER',
  'SESSION_ERROR',
  'SETTING_UP',
  'SETUP_FAILED',
  'ARCHIVING',
  'ARCHIVED',
  'AGENT_WORKING',
  'DEV_SERVER_RUNNING',
  'WAITING_FOR_CI',
  'FIXING_CI_FAILURES',
  'FIXING_REVIEW_COMMENTS',
  'CHECKING_PR',
  'MERGED',
  'PR_CLOSED',
  'READY_TO_MERGE',
  'READY_FOR_REVIEW',
  'NO_SESSION_STARTED',
  'READY_FOR_NEXT_PROMPT',
] as const satisfies readonly WorkspaceStatusReasonCode[];

const WORKSPACE_STATUS_REASON_TONES = [
  'neutral',
  'working',
  'waiting',
  'attention',
  'success',
  'danger',
] as const satisfies readonly WorkspaceStatusReasonTone[];

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
  runtimePhase: z.enum(['loading', 'starting', 'running', 'idle', 'stopping', 'error']),
  processState: z.enum(['unknown', 'alive', 'stopped']),
  activity: z.enum(['WORKING', 'IDLE']),
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
  activityState: z.enum(['WORKING', 'IDLE']),
  ciState: z.enum([
    'NONE',
    'RUNNING',
    'FAILING',
    'PASSING',
    'UNKNOWN',
    'CLOSED',
    'MERGED',
    'CONFLICT',
  ]),
});

const WorkspaceStatusReasonSchema = z.object({
  code: z.enum(WORKSPACE_STATUS_REASON_CODES),
  label: z.string(),
  tone: z.enum(WORKSPACE_STATUS_REASON_TONES),
  needsUser: z.boolean(),
});

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
  runScriptStatus: z.nativeEnum(RunScriptStatus),
  hasHadSessions: z.boolean(),
  isWorking: z.boolean(),
  pendingRequestType: z.enum(['plan_approval', 'user_question', 'permission_request']).nullable(),
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
