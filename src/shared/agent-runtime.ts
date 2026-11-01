import { z } from 'zod';
import { agentSourceScanSchema } from './agent-source-state';
import {
  AgentActivationState,
  AgentDeliveryState,
  AgentEvaluationStatus,
  AgentLaunchPhase,
  SessionProvider,
} from './core/enums';
import {
  agentActivationGenerationSchema,
  agentDefinitionRevisionSchema,
  agentTriggerRevisionSchema,
  agentDefinitionInputSchema,
  agentExecutionConfigSchema,
  agentRunInputSchema,
  agentTriggerInputSchema,
} from './schemas/agent-definition.schema';

const id = z.string().trim().min(1).max(256);
const revision = agentDefinitionRevisionSchema;
const generation = agentActivationGenerationSchema;
const timestamp = z.iso.datetime();
const providerTimestamp = z.string().regex(/^\d{1,20}\.\d{1,20}$/);
const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);
export const agentSourceOrderSchema = revision;
export const agentActivationStateSchema = z.enum(AgentActivationState);
export const agentLaunchPhaseSchema = z.enum(AgentLaunchPhase);
export const agentDeliveryStateSchema = z.enum(AgentDeliveryState);
export const agentEvaluationStatusSchema = z.enum(AgentEvaluationStatus);

const eventFields = {
  version: z.literal(1),
  occurredAt: timestamp,
  observedAt: timestamp,
  sourceUrl: z.url().max(2048),
  actorId: id,
};
export const agentEventPayloadSchema = z.discriminatedUnion('provider', [
  z.strictObject({
    ...eventFields,
    provider: z.literal('GITHUB'),
    repositoryId: id,
    repositoryFullName: id,
    action: z.string().min(1).max(64),
    creatorId: id,
    issue: z.strictObject({
      number: z.number().int().positive(),
      title: z.string().max(4096),
      body: z.string().max(100_000),
      addedLabel: z.string().max(256).nullable(),
    }),
  }),
  z.strictObject({
    ...eventFields,
    provider: z.literal('SLACK'),
    workspaceId: id,
    appId: id,
    channelId: id,
    action: z.literal('message'),
    eventTs: providerTimestamp,
    threadTs: providerTimestamp.nullable(),
    actorType: z.enum(['HUMAN', 'BOT', 'SYSTEM']),
    subtype: z.string().max(100).nullable(),
    text: z.string().max(100_000),
  }),
]);
export const agentEventInputSchema = z.strictObject({
  connectionId: id,
  providerEventId: id,
  payload: agentEventPayloadSchema,
});
export const agentEventOrderInputSchema = z.strictObject({
  connectionId: id,
  eventIds: z
    .array(id)
    .min(1)
    .max(1000)
    .refine((ids) => new Set(ids).size === ids.length, 'Event identities must be unique'),
});

export const agentActivationBoundarySchema = z.discriminatedUnion('provider', [
  z
    .strictObject({
      provider: z.literal('GITHUB'),
      headEventId: id.nullable(),
      sourceOrder: generation,
    })
    .refine(
      (boundary) => boundary.headEventId !== null || boundary.sourceOrder === 0,
      'An empty baseline has ordinal zero'
    ),
  z.strictObject({
    provider: z.literal('SLACK'),
    workspaceId: id,
    appId: id,
    channels: z
      .array(z.strictObject({ channelId: id, eventTs: providerTimestamp }))
      .min(1)
      .max(100)
      .refine(
        (channels) =>
          new Set(channels.map((channel) => channel.channelId)).size === channels.length,
        'Channel boundaries must be unique'
      ),
  }),
]);
export const agentPendingActivationSchema = z.strictObject({
  version: z.literal(1),
  activationGeneration: revision,
  definitionRevision: revision,
  triggerRevision: agentTriggerRevisionSchema,
  connectionId: id,
  nonce: id,
  expiresAt: timestamp,
  channels: z
    .array(z.strictObject({ channelId: id, eventTs: providerTimestamp.nullable() }))
    .max(100),
});
export const agentSourceCursorSchema = z.discriminatedUnion('provider', [
  z.strictObject({
    version: z.literal(1),
    provider: z.literal('GITHUB'),
    committedHeadEventId: id.nullable(),
    scan: agentSourceScanSchema.nullable(),
  }),
  z.strictObject({
    version: z.literal(1),
    provider: z.literal('SLACK'),
    gaps: z.array(z.strictObject({ from: timestamp, to: timestamp.nullable() })).max(100),
  }),
]);
export const agentSourceHealthSchema = z.strictObject({
  state: z.enum(['READY', 'STARTING', 'CATCHING_UP', 'DISCONNECTED', 'ERROR', 'RECOVERY_REQUIRED']),
  reasonCode: reasonCode.nullable(),
  updatedAt: timestamp,
});
export const agentResolvedExecutionConfigSchema = agentExecutionConfigSchema.safeExtend({
  provider: z.enum(SessionProvider),
  model: id,
});
export const agentClassifierIdentitySchema = z.strictObject({
  provider: z.enum(SessionProvider),
  model: id,
  promptVersion: id,
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const agentEvaluationSnapshotSchema = z.strictObject({
  definition: agentDefinitionInputSchema,
  trigger: agentTriggerInputSchema,
  executionConfig: agentResolvedExecutionConfigSchema,
  input: agentRunInputSchema,
});
export const agentEvaluationInputSchema = z.strictObject({
  eventId: id,
  agentDefinitionId: id,
  triggerId: id,
  definitionRevision: revision,
  triggerRevision: agentTriggerRevisionSchema,
  activationGeneration: generation,
  status: agentEvaluationStatusSchema,
  reasonCode,
  explanation: z.string().max(2000),
  executionConfig: agentResolvedExecutionConfigSchema,
  input: agentRunInputSchema,
  classifier: agentClassifierIdentitySchema.optional(),
});
export const agentAdmissionInputSchema = z.strictObject({
  evaluationId: id,
  definitionRevision: revision,
  triggerRevision: agentTriggerRevisionSchema,
  activationGeneration: generation,
});
export const agentRuntimeReasonSchema = z.enum([
  'NOT_FOUND',
  'OWNERSHIP_MISMATCH',
  'STALE_REVISION',
  'STALE_EVENT_COHORT',
  'ACTIVATION_STARTING',
  'SOURCE_ORDER_PENDING',
  'BEFORE_ACTIVATION',
  'SOURCE_IDENTITY_MISMATCH',
  'DEFINITION_DISABLED',
  'TRIGGER_DISABLED',
  'CONNECTION_UNAVAILABLE',
  'PROJECT_ARCHIVED',
  'EVENT_EXPIRED',
  'INVALID_STORED_DATA',
  'NOT_MATCHED',
  'EARLIER_EVALUATION_PENDING',
  'EARLIER_EVALUATION_ERROR',
  'QUEUE_OVERFLOW',
  'QUEUE_EXPIRED',
  'CAPACITY',
  'EMPTY',
]);
const rejection = { reason: agentRuntimeReasonSchema };
export const agentEvaluationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('RECORDED'), evaluationId: id }),
  z.strictObject({ status: z.literal('DUPLICATE'), evaluationId: id }),
  z.strictObject({ status: z.literal('DEFERRED'), ...rejection }),
  z.strictObject({ status: z.literal('REJECTED'), ...rejection }),
]);
export const agentAdmissionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ADMITTED'), runId: id }),
  z.strictObject({ status: z.literal('COALESCED'), runId: id }),
  z.strictObject({ status: z.literal('DEFERRED'), ...rejection }),
  z.strictObject({ status: z.literal('REJECTED'), ...rejection }),
]);
export const agentClaimResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('CLAIMED'),
    runId: id,
    workerGeneration: revision,
    attemptGeneration: revision,
    reservedWorkspaceId: id,
    reservedSessionId: id,
    initialMessageId: id,
  }),
  z.strictObject({ status: z.literal('DEFERRED'), ...rejection }),
]);
export const agentRunResultSchema = z.strictObject({
  version: z.literal(1),
  summary: z.string().max(2000),
  pullRequests: z
    .array(z.strictObject({ url: z.url().max(2048), number: z.number().int().positive() }))
    .max(20),
});
export const agentInitialDeliverySchema = z.strictObject({
  runId: id,
  state: agentDeliveryStateSchema,
  attemptGeneration: revision,
  sendAttemptId: id,
  messageId: id,
  providerTurnId: id.nullable(),
  sendingAt: timestamp.nullable(),
  acceptedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
});

export type AgentEventInput = z.input<typeof agentEventInputSchema>;
export type AgentEventOrderInput = z.input<typeof agentEventOrderInputSchema>;
export type AgentEvaluationInput = z.input<typeof agentEvaluationInputSchema>;
export type AgentAdmissionInput = z.input<typeof agentAdmissionInputSchema>;
export type AgentEvaluationResult = z.infer<typeof agentEvaluationResultSchema>;
export type AdmissionResult = z.infer<typeof agentAdmissionResultSchema>;
export type AgentClaimResult = z.infer<typeof agentClaimResultSchema>;
export type AgentRuntimeReason = z.infer<typeof agentRuntimeReasonSchema>;
export type AgentEventPayload = z.infer<typeof agentEventPayloadSchema>;

export type AgentActivationBoundary = z.infer<typeof agentActivationBoundarySchema>;
