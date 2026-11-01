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
  WorkspaceCreationSource,
  WorkspaceProviderSelection,
  WorkspaceStatus,
} from '@/shared/core';
import { prDeliveryModeSchema } from '@/shared/schemas/pr-event.schema';
import {
  SESSION_RUNTIME_ACTIVITIES,
  SESSION_RUNTIME_PHASES,
  SESSION_RUNTIME_PROCESS_STATES,
} from '@/shared/session-runtime';
import { WORKSPACE_CI_OBSERVATIONS, WORKSPACE_FLOW_PHASES } from '@/shared/workspace-flow-state';
import { WorkspacePullRequestSchema } from '@/shared/workspace-pr';
import { WorkspacePRSummarySchema } from '@/shared/workspace-pr-summary';
import {
  WORKSPACE_PENDING_REQUEST_TYPES,
  WORKSPACE_STATUS_REASON_CODES,
  WORKSPACE_STATUS_REASON_TONES,
} from '@/shared/workspace-status-reason';
import { WorkspaceConversationSummarySchema } from './workspace-conversation-summary';

const SessionRuntimeLastExitSchema = z.object({
  code: z.number().nullable(),
  timestamp: z.string(),
  unexpected: z.boolean(),
});

export const WorkspaceSessionSummarySchema = z.object({
  sessionId: z.string(),
  name: z.string().nullable(),
  workflow: z.string().nullable(),
  model: z.string().nullable(),
  provider: z.nativeEnum(SessionProvider).optional(),
  codexAccountId: z.string().nullable().optional(),
  persistedStatus: z.nativeEnum(SessionStatus),
  runtimePhase: z.enum(SESSION_RUNTIME_PHASES),
  processState: z.enum(SESSION_RUNTIME_PROCESS_STATES),
  activity: z.enum(SESSION_RUNTIME_ACTIVITIES),
  updatedAt: z.string(),
  lastExit: SessionRuntimeLastExitSchema.nullable(),
  errorMessage: z.string().nullable().optional(),
});

export const WorkspaceGitStatsSchema = z.object({
  total: z.number(),
  additions: z.number(),
  deletions: z.number(),
  hasUncommitted: z.boolean(),
});

export const WorkspaceSidebarStatusSchema = z.object({
  activityState: z.enum(WORKSPACE_SIDEBAR_ACTIVITY_STATES),
  ciState: z.enum(WORKSPACE_SIDEBAR_CI_STATES),
});

export const WorkspaceStatusReasonSchema = z.object({
  code: z.enum(WORKSPACE_STATUS_REASON_CODES),
  label: z.string(),
  tone: z.enum(WORKSPACE_STATUS_REASON_TONES),
  needsUser: z.boolean(),
});

/** Flat board/sidebar contract. */
export const WorkspaceSummarySchema = z.object({
  conversationSummary: WorkspaceConversationSummarySchema.nullable().optional(),
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  status: z.nativeEnum(WorkspaceStatus),
  defaultSessionProvider: z.nativeEnum(WorkspaceProviderSelection).optional(),
  createdAt: z.string().datetime({ offset: true }),
  branchName: z.string().nullable(),
  worktreePath: z.string().nullable(),
  initErrorMessage: z.string().nullable(),
  prs: z.array(WorkspacePullRequestSchema),
  prSummary: WorkspacePRSummarySchema,
  prUrl: z.string().nullable(),
  prNumber: z.number().nullable(),
  prState: z.nativeEnum(PRState),
  prCiStatus: z.nativeEnum(CIStatus),
  ratchetEnabled: z.boolean(),
  ratchetState: z.nativeEnum(RatchetState),
  prMonitoring: z.object({
    deliveryMode: prDeliveryModeSchema,
    enabled: z.boolean(),
    recipientSessionId: z.string().nullable(),
    bindingRevision: z.number().int().nonnegative(),
    pauseReason: z.string().nullable(),
    pendingEventCount: z.number().int().nonnegative(),
  }),
  runScriptStatus: z.nativeEnum(RunScriptStatus),
  githubIssueNumber: z.number().nullable(),
  githubIssueUrl: z.string().nullable(),
  linearIssueId: z.string().nullable(),
  linearIssueIdentifier: z.string().nullable(),
  linearIssueUrl: z.string().nullable(),
  creationSource: z.nativeEnum(WorkspaceCreationSource),
  sessionSummaries: z.array(WorkspaceSessionSummarySchema),
  pendingRequestType: z.enum(WORKSPACE_PENDING_REQUEST_TYPES).nullable(),
  gitStats: WorkspaceGitStatsSchema.nullable(),
  lastActivityAt: z.string().nullable(),
  isWorking: z.boolean(),
  kanbanColumn: z.nativeEnum(KanbanColumn).nullable(),
  sidebarStatus: WorkspaceSidebarStatusSchema,
  ratchetButtonAnimated: z.boolean(),
  flowPhase: z.enum(WORKSPACE_FLOW_PHASES),
  ciObservation: z.enum(WORKSPACE_CI_OBSERVATIONS),
  statusReason: WorkspaceStatusReasonSchema,
});

type SerializedWorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;
export type WorkspaceSummary<TCreatedAt extends string | Date = string> = Omit<
  SerializedWorkspaceSummary,
  'createdAt'
> & { createdAt: TCreatedAt };

/** tRPC retains Date for createdAt; all other summary timestamps already use ISO strings. */
export function serializeWorkspaceSummary<T extends WorkspaceSummary<Date>>(
  summary: T
): Omit<T, 'createdAt'> & { createdAt: string } {
  return { ...summary, createdAt: summary.createdAt.toISOString() };
}
export function deserializeWorkspaceSummary<T extends WorkspaceSummary>(
  summary: T
): Omit<T, 'createdAt'> & { createdAt: Date } {
  return { ...summary, createdAt: new Date(summary.createdAt) };
}
