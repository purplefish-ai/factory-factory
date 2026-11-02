import { z } from 'zod';
import { storedAgentRunContextSchema } from '@/shared/agent-run-context';
import {
  frozenSubmittedIntentSchema,
  frozenIntentSettingsSchema,
  submittedIntentSchema,
} from './chat-intent.schema';
import { recoveryJsonStorageSchema } from './recovery-json-storage.schema';

// Explicit scalar projections: relation objects and credentials never enter a backup.
export const periodicTaskRecoverySchema = z.strictObject({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  prompt: z.string(),
  cadence: z.enum(['EVERY_MINUTE', 'EVERY_FIVE_MINUTES', 'DAILY', 'WEEKLY', 'MONTHLY']),
  scheduledTime: z.string().nullable(),
  timezone: z.string().nullable(),
  scheduledDayOfMonth: z.number().int().nullable(),
  isEnabled: z.boolean(),
  nextRunAt: z.iso.datetime(),
  lastRunAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const periodicTaskExecutionRecoverySchema = z.strictObject({
  launchSnapshot: z.json().nullable().optional().default(null),
  id: z.string(),
  periodicTaskId: z.string(),
  workspaceId: z.string().nullable(),
  status: z.enum(['RUNNING', 'PR_CREATED', 'COMPLETED', 'FAILED', 'SKIPPED']),
  prUrl: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export const agentDefinitionRecoverySchema = z.strictObject({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  instructions: z.string(),
  isEnabled: z.boolean(),
  executionConfig: z.json(),
  definitionRevision: z.number().int(),
  managementRevision: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const agentConnectionRecoverySchema = z.strictObject({
  id: z.string(),
  provider: z.enum(['SLACK', 'GITHUB']),
  externalId: z.string(),
  name: z.string(),
  isEnabled: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const agentTriggerRecoverySchema = z.strictObject({
  id: z.string(),
  agentDefinitionId: z.string(),
  type: z.enum(['SCHEDULE', 'SLACK_MESSAGE', 'GITHUB_ISSUE']),
  connectionId: z.string().nullable(),
  description: z.string(),
  config: z.json(),
  filterInstructions: z.string().nullable(),
  isEnabled: z.boolean(),
  isConfigured: z.boolean().nullable(),
  triggerRevision: z.number().int(),
  activationGeneration: z.number().int(),
  activationState: z.enum(['PAUSED', 'STARTING', 'ACTIVE']),
  activationBoundary: z.json().nullable(),
  pendingActivation: z.json().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const agentRunRecoverySchema = z
  .strictObject({
    id: z.string(),
    agentDefinitionId: z.string(),
    triggerId: z.string().nullable(),
    contextExpiredAt: z.iso.datetime().nullable(),
    idempotencyKey: z.string(),
    status: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'PR_CREATED', 'FAILED', 'CANCELLED']),
    eventId: z.string().nullable(),
    definitionRevision: z.number().int(),
    triggerRevision: z.number().int(),
    activationGeneration: z.number().int(),
    launchPhase: z.enum([
      'RESERVED',
      'PROVISIONING',
      'READY',
      'DISPATCHING',
      'ACTIVE',
      'NEEDS_ATTENTION',
      'FINISHED',
    ]),
    reservedWorkspaceId: z.string().nullable(),
    reservedSessionId: z.string().nullable(),
    initialMessageId: z.string().nullable(),
    workerGeneration: z.number().int(),
    attemptGeneration: z.number().int(),
    attemptCount: z.number().int(),
    nextAttemptAt: z.iso.datetime().nullable(),
    leaseExpiresAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    reasonCode: z.string().nullable(),
    result: z.json().nullable(),
    effectiveExecution: z.json().nullable(),
    launchPreparation: z.json().nullable(),
    definitionSnapshot: z.json(),
    triggerSnapshot: z.json().nullable(),
    input: z.json(),
    workspaceId: z.string().nullable(),
    errorMessage: z.string().nullable(),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
  })
  .superRefine((row, ctx) => {
    const marked = [row.definitionSnapshot, row.triggerSnapshot, row.input].some(
      (value) =>
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        value.state === 'EXPIRED'
    );
    if (
      (row.contextExpiredAt !== null || marked) &&
      !storedAgentRunContextSchema.safeParse(row).success
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Expired context must retain its atomic timestamp and markers',
      });
    }
  });

export const agentProposalRecoverySchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  revision: z.number().int(),
  specification: z.json(),
  sourceNames: z.json(),
  agentDefinitionId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const agentSourceStateRecoverySchema = z.strictObject({
  authorityRevision: z.number().int(),
  lastSourceOrder: z.number().int(),
  connectionId: z.string(),
  isReady: z.boolean(),
  cursor: z.json().nullable(),
  health: z.json().nullable(),
  lastObservedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export const agentSourcePageRecoverySchema = z.strictObject({
  id: z.string(),
  connectionId: z.string(),
  scanId: z.string(),
  ordinal: z.number().int(),
  phase: z.string(),
  requestPage: z.number().int(),
  nextPage: z.number().int().nullable(),
  sourceOrder: z.number().int().nullable(),
  evidence: z.json(),
  createdAt: z.iso.datetime(),
});

export const agentSourceBaselineRecoverySchema = z.strictObject({
  id: z.string(),
  connectionId: z.string(),
  headEventId: z.string().nullable(),
  afterHeadEventId: z.string().nullable(),
  sourceOrder: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
});

export const agentEventRecoverySchema = z.strictObject({
  id: z.string(),
  connectionId: z.string(),
  providerEventId: z.string(),
  sourceOrder: z.number().int().nullable(),
  payload: z.json().nullable(),
  occurredAt: z.iso.datetime(),
  observedAt: z.iso.datetime(),
  payloadExpiresAt: z.iso.datetime(),
  identityExpiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export const agentEvaluationRecoverySchema = z.strictObject({
  id: z.string(),
  eventId: z.string(),
  connectionId: z.string(),
  agentDefinitionId: z.string(),
  triggerId: z.string(),
  definitionRevision: z.number().int(),
  triggerRevision: z.number().int(),
  activationGeneration: z.number().int(),
  status: z.enum(['MATCHED', 'SKIPPED', 'ERROR']),
  reasonCode: z.string(),
  explanation: z.string(),
  attemptCount: z.number().int(),
  nextAttemptAt: z.iso.datetime().nullable(),
  configurationSnapshot: z.json(),
  classifier: z.json().nullable(),
  runId: z.string().nullable(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const agentInitialDeliveryRecoverySchema = z.strictObject({
  id: z.string(),
  runId: z.string(),
  state: z.enum(['PENDING', 'SENDING', 'ACCEPTED', 'FINISHED', 'AMBIGUOUS']),
  attemptGeneration: z.number().int(),
  sendAttemptId: z.string(),
  messageId: z.string(),
  providerTurnId: z.string().nullable(),
  evidence: z.json().nullable(),
  sendingAt: z.iso.datetime().nullable(),
  acceptedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const workspaceNotificationRecoverySchema = z.strictObject({
  recoveryHeld: z.boolean().optional().default(false),
  id: z.string(),
  workspaceId: z.string(),
  sourceWorkspaceId: z.string(),
  sourceWorkspaceName: z.string(),
  sourceProjectName: z.string(),
  message: z.string(),
  direction: z.enum(['CHILD_TO_PARENT', 'PARENT_TO_CHILD']),
  deliveredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const workspaceLaunchOriginRecoverySchema = z.strictObject({
  childHistoryVersion: z.number().int().nullable(),
  runId: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  createdAt: z.iso.datetime(),
});

export const workspaceChildOriginRecoverySchema = z.strictObject({
  parentWorkspaceId: z.string(),
  childWorkspaceId: z.string(),
  createdAt: z.iso.datetime(),
});

export const agentSessionLaunchOriginRecoverySchema = z.strictObject({
  runId: z.string(),
  sessionId: z.string(),
  workspaceId: z.string(),
  execution: z.json(),
  createdAt: z.iso.datetime(),
});

export const sessionLifecycleEventRecoverySchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  kind: z.enum(['TURN_INTERRUPTED', 'SESSION_STOPPED']),
  reason: z.enum([
    'PROMPT_TIMEOUT',
    'PROVIDER_ERROR',
    'USER_STOP',
    'SESSION_CLOSED',
    'WORKSPACE_ARCHIVED',
    'UNEXPECTED_EXIT',
    'SYSTEM_STOP',
    'VOICE_INTERRUPT',
  ]),
  message: z.string(),
  dedupeKey: z.string(),
  createdAt: z.iso.datetime(),
});

export const decisionLogRecoverySchema = z.strictObject({
  id: z.string(),
  agentId: z.string(),
  decision: z.string(),
  reasoning: z.string(),
  context: z.string().nullable(),
  timestamp: z.iso.datetime(),
});

export const agentSourceCheckpointRecoverySchema = z.strictObject({
  connectionId: z.string(),
  scanId: z.string(),
  status: z.enum(['BUILDING', 'INDEXED', 'COMPLETE', 'INVALID']),
  nextOrdinal: z.number().int(),
  entryCount: z.number().int(),
  executableCount: z.number().int(),
  verifiedCount: z.number().int(),
  verification: z.json().nullable(),
  headEventId: z.string().nullable(),
  boundaryKnown: z.boolean(),
  previousBoundaryEventId: z.string().nullable(),
  initialSourceOrder: z.number().int().nullable(),
  sourceOrder: z.number().int().nullable(),
  validationCursor: z.json().nullable(),
});
export const agentSourceHeadRecoverySchema = z.strictObject({
  connectionId: z.string(),
  scanId: z.string(),
  providerEventId: z.string(),
  position: z.number().int(),
  precedingEventCount: z.number().int(),
});
export const chatIntentRecoverySchema = z
  .strictObject({
    id: z.number().int().positive(),
    sessionId: z.string(),
    messageId: z.string(),
    fingerprint: z.string(),
    submitted: frozenSubmittedIntentSchema,
    desired: frozenIntentSettingsSchema,
    revision: z.number().int(),
    status: z.enum(['queued', 'uncertain', 'committed', 'cancelled', 'failed']),
    attemptId: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .superRefine((row, ctx) => {
    const submitted = submittedIntentSchema.safeParse(row.submitted);
    if (submitted.success && submitted.data.id !== row.messageId) {
      ctx.addIssue({
        code: 'custom',
        path: ['submitted', 'id'],
        message: 'Submitted intent identity does not match messageId',
      });
    }
  });
export const promptDispatchAttemptRecoverySchema = z.strictObject({
  id: z.string(),
  sessionId: z.string(),
  members: z.array(
    z
      .object({ messageId: z.string(), owner: z.enum(['human', 'external']), message: z.json() })
      .catchall(z.json())
  ),
  content: z.json(),
  effectiveSettings: frozenIntentSettingsSchema,
  providerIdentity: z.json(),
  sendGeneration: z.number().int(),
  status: z.enum(['uncertain', 'committed', 'cancelled', 'queued']),
  evidence: z.string().nullable(),
  createdAt: z.iso.datetime(),
  settledAt: z.iso.datetime().nullable(),
});

export const durableRecoverySchema = z
  .strictObject({
    jsonStorage: recoveryJsonStorageSchema,
    agentSourceCheckpoint: z.array(agentSourceCheckpointRecoverySchema),
    agentSourceHead: z.array(agentSourceHeadRecoverySchema),
    chatIntent: z.array(chatIntentRecoverySchema),
    promptDispatchAttempt: z.array(promptDispatchAttemptRecoverySchema),
    periodicTask: z.array(periodicTaskRecoverySchema),
    periodicTaskExecution: z.array(periodicTaskExecutionRecoverySchema),
    agentDefinition: z.array(agentDefinitionRecoverySchema),
    agentConnection: z.array(agentConnectionRecoverySchema),
    agentTrigger: z.array(agentTriggerRecoverySchema),
    agentRun: z.array(agentRunRecoverySchema),
    agentProposal: z.array(agentProposalRecoverySchema),
    agentSourceState: z.array(agentSourceStateRecoverySchema),
    agentSourcePage: z.array(agentSourcePageRecoverySchema),
    agentSourceBaseline: z.array(agentSourceBaselineRecoverySchema),
    agentEvent: z.array(agentEventRecoverySchema),
    agentEvaluation: z.array(agentEvaluationRecoverySchema),
    agentInitialDelivery: z.array(agentInitialDeliveryRecoverySchema),
    workspaceNotification: z.array(workspaceNotificationRecoverySchema),
    workspaceLaunchOrigin: z.array(workspaceLaunchOriginRecoverySchema),
    workspaceChildOrigin: z.array(workspaceChildOriginRecoverySchema),
    agentSessionLaunchOrigin: z.array(agentSessionLaunchOriginRecoverySchema),
    sessionLifecycleEvent: z.array(sessionLifecycleEventRecoverySchema),
    decisionLog: z.array(decisionLogRecoverySchema),
  })
  .superRefine((data, ctx) => {
    const attempts = new Map(data.promptDispatchAttempt.map((row) => [row.id, row]));
    for (const intent of data.chatIntent) {
      validateIntentMembership(intent, attempts, ctx);
    }
    for (const attempt of data.promptDispatchAttempt) {
      const ids = attempt.members.map((member) => member.messageId);
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: 'custom', message: 'Duplicate frozen dispatch member' });
      }
      if (
        attempt.status === 'uncertain' &&
        attempt.members.some(
          (member) =>
            member.owner === 'human' &&
            !data.chatIntent.some(
              (row) =>
                row.status === 'uncertain' &&
                row.attemptId === attempt.id &&
                row.sessionId === attempt.sessionId &&
                row.messageId === member.messageId
            )
        )
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Uncertain dispatch is missing its complete uncertain human membership',
        });
      }
    }
  });
export type DurableRecovery = z.infer<typeof durableRecoverySchema>;

function validateIntentMembership(
  intent: z.infer<typeof chatIntentRecoverySchema>,
  attempts: ReadonlyMap<string, z.infer<typeof promptDispatchAttemptRecoverySchema>>,
  ctx: z.RefinementCtx
) {
  const attempt = intent.attemptId ? attempts.get(intent.attemptId) : undefined;
  if (intent.status === 'uncertain' && attempt?.status !== 'uncertain') {
    ctx.addIssue({
      code: 'custom',
      message: 'Uncertain chat intent requires its uncertain frozen dispatch attempt',
    });
  }
  if (!intent.attemptId) {
    return;
  }
  if (
    !attempt ||
    attempt.sessionId !== intent.sessionId ||
    !attempt.members.some(
      (member) => member.owner === 'human' && member.messageId === intent.messageId
    )
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Chat intent has missing or foreign frozen dispatch membership',
    });
  }
}
