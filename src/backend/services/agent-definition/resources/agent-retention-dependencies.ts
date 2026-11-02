import {
  agentActivationBoundarySchema,
  agentClassifierIdentitySchema,
  agentEvaluationFailureSnapshotSchema,
  agentEvaluationSnapshotSchema,
  agentEventPayloadSchema,
  agentPendingActivationSchema,
  agentSourceHealthSchema,
  type AgentActivationBoundary,
} from '@/shared/agent-runtime';
import { agentGithubCursorSchema } from '@/shared/agent-source-state';
import {
  agentTriggerInputSchema,
  type AgentTriggerInput,
} from '@/shared/schemas/agent-definition.schema';
import { Prisma } from '@prisma-gen/client';
import type {
  AgentConnection,
  AgentEvent,
  AgentEvaluation,
  AgentSourceState,
  AgentTrigger,
} from '@prisma-gen/client';

export type RetentionReason =
  | 'ACTIVE_RUN'
  | 'UNRESOLVED_DECISION'
  | 'ACTIVATION_DEPENDENCY'
  | 'INVALID_STORED_DATA'
  | 'DEPENDENCY_LIMIT'
  | 'SOURCE_DEPENDENCY'
  | 'EVALUATIONS_REMAIN';

/** Resolve only the dependencies needed by this candidate, with bounded projections. */
export async function retentionDependency(
  tx: Prisma.TransactionClient,
  event: AgentEvent,
  identity: boolean,
  assertCurrent: () => void,
  limit: number
): Promise<RetentionReason | null> {
  if (event.payload === null) {
    // Prisma reads JSON null and SQL NULL as the same JS value. Only SQL NULL
    // is the completed payload-pruning marker; JSON null is malformed proof.
    const jsonNull = await tx.agentEvent.findFirst({
      where: { id: event.id, payload: { equals: Prisma.JsonNull } },
      select: { id: true },
    });
    assertCurrent();
    if (jsonNull) {
      return 'INVALID_STORED_DATA';
    }
  }
  const active = await tx.agentRun.findFirst({
    where: { eventId: event.id, status: { in: ['QUEUED', 'RUNNING'] } },
    select: { id: true },
  });
  assertCurrent();
  if (active) {
    return 'ACTIVE_RUN';
  }
  // Keep the whole event cohort while retry/admission is unresolved. In particular,
  // an earlier ERROR/winner/overflow fact must not disappear under a later MATCHED.
  const pending = await tx.agentEvaluation.findFirst({
    where: {
      eventId: event.id,
      OR: [
        { status: 'ERROR', nextAttemptAt: { not: null } },
        { status: 'MATCHED', runId: null },
      ],
    },
    select: { id: true },
  });
  assertCurrent();
  if (pending) {
    return 'UNRESOLVED_DECISION';
  }
  const connection = await tx.agentConnection.findUnique({
    where: { id: event.connectionId },
    include: { sourceState: true },
  });
  assertCurrent();
  if (!connection) {
    return 'INVALID_STORED_DATA';
  }
  const sourceReason = sourceDependency(connection, event, identity);
  if (sourceReason) {
    return sourceReason;
  }
  const triggers = await tx.agentTrigger.findMany({
    where: { connectionId: event.connectionId },
    include: { agentDefinition: { select: { definitionRevision: true } } },
    take: limit + 1,
    orderBy: { id: 'asc' },
  });
  assertCurrent();
  if (triggers.length > limit) {
    return 'DEPENDENCY_LIMIT';
  }
  for (const trigger of triggers) {
    const reason = triggerDependency(trigger, connection, event);
    if (reason) {
      return reason;
    }
  }
  return null;
}

type RetentionTrigger = AgentTrigger & { agentDefinition: { definitionRevision: number } };

function triggerDependency(
  trigger: RetentionTrigger,
  connection: AgentConnection,
  event: AgentEvent
): RetentionReason | null {
  if (trigger.activationState === 'STARTING') {
    return 'ACTIVATION_DEPENDENCY';
  }
  const settings = agentTriggerInputSchema.safeParse({
    type: trigger.type,
    description: trigger.description,
    filterInstructions: trigger.filterInstructions,
    isEnabled: trigger.isEnabled,
    connectionId: trigger.connectionId,
    config: trigger.config,
  });
  const needsBoundary = trigger.activationState === 'ACTIVE' || trigger.activationBoundary !== null;
  const boundary = agentActivationBoundarySchema.safeParse(trigger.activationBoundary);
  if (
    !settings.success ||
    (needsBoundary && !boundary.success) ||
    !validPendingActivation(trigger) ||
    !validTriggerSource(settings.data, boundary.success ? boundary.data : null, connection, event)
  ) {
    return 'INVALID_STORED_DATA';
  }
  return null;
}

function validTriggerSource(
  settings: AgentTriggerInput,
  boundary: AgentActivationBoundary | null,
  connection: AgentConnection,
  event: AgentEvent
) {
  if (settings.type === 'GITHUB_ISSUE') {
    return (
      connection.provider === 'GITHUB' &&
      settings.config.repositoryIds.some((id) => connection.externalId === `gh:${id}`) &&
      (boundary === null || boundary.provider === 'GITHUB')
    );
  }
  if (settings.type !== 'SLACK_MESSAGE' || connection.provider !== 'SLACK') {
    return false;
  }
  if (boundary === null) {
    return true;
  }
  if (boundary.provider !== 'SLACK' || boundary.workspaceId !== connection.externalId) {
    return false;
  }
  if (event.payload === null) {
    return true;
  }
  const payload = agentEventPayloadSchema.safeParse(event.payload);
  return (
    payload.success && payload.data.provider === 'SLACK' && payload.data.appId === boundary.appId
  );
}

function validPendingActivation(trigger: RetentionTrigger) {
  if (trigger.pendingActivation === null) {
    return true;
  }
  const pending = agentPendingActivationSchema.safeParse(trigger.pendingActivation);
  return (
    pending.success &&
    pending.data.connectionId === trigger.connectionId &&
    pending.data.definitionRevision === trigger.agentDefinition.definitionRevision &&
    pending.data.activationGeneration === trigger.activationGeneration &&
    pending.data.triggerRevision === trigger.triggerRevision
  );
}

function sourceDependency(
  connection: (AgentConnection & { sourceState: AgentSourceState | null }) | null,
  event: AgentEvent,
  identity: boolean
): RetentionReason | null {
  if (!connection) {
    return 'INVALID_STORED_DATA';
  }
  if (!validSourcePayload(connection, event)) {
    return 'INVALID_STORED_DATA';
  }
  const source = connection.sourceState;
  if (source?.health != null) {
    const health = agentSourceHealthSchema.safeParse(source.health);
    if (!health.success) {
      return 'INVALID_STORED_DATA';
    }
    if (health.data.state === 'RECOVERY_REQUIRED') {
      return 'SOURCE_DEPENDENCY';
    }
  }
  if (connection.provider !== 'GITHUB') {
    return null;
  }
  const cursor = agentGithubCursorSchema.safeParse(source?.cursor);
  if (
    !(
      source &&
      cursor.success &&
      Number.isSafeInteger(source.lastSourceOrder) &&
      source.lastSourceOrder >= 0
    )
  ) {
    return 'INVALID_STORED_DATA';
  }
  // Already-finalized chunks still belong to the active interval. No event
  // identity is collectible until the entire scan has committed its boundary.
  if (
    identity &&
    (cursor.data.scan !== null ||
      event.sourceOrder === null ||
      event.sourceOrder < 1 ||
      event.sourceOrder > source.lastSourceOrder)
  ) {
    return 'SOURCE_DEPENDENCY';
  }
  return null;
}

export function validRetentionEvaluation(
  evaluation: AgentEvaluation,
  run: { agentDefinitionId: string; eventId: string | null } | null
) {
  const snapshot =
    evaluation.status === 'MATCHED'
      ? agentEvaluationSnapshotSchema.safeParse(evaluation.configurationSnapshot)
      : agentEvaluationSnapshotSchema
          .or(agentEvaluationFailureSnapshotSchema)
          .safeParse(evaluation.configurationSnapshot);
  return (
    snapshot.success &&
    snapshot.data.input.eventId === evaluation.eventId &&
    (evaluation.classifier === null ||
      agentClassifierIdentitySchema.safeParse(evaluation.classifier).success) &&
    (evaluation.runId === null ||
      (run !== null &&
        run.agentDefinitionId === evaluation.agentDefinitionId &&
        run.eventId === evaluation.eventId))
  );
}

function validSourcePayload(connection: AgentConnection, event: AgentEvent) {
  if (event.payload === null) {
    return true;
  }
  const payload = agentEventPayloadSchema.safeParse(event.payload);
  if (!payload.success || payload.data.provider !== connection.provider) {
    return false;
  }
  const externalId =
    payload.data.provider === 'GITHUB'
      ? `gh:${payload.data.repositoryId}`
      : payload.data.workspaceId;
  return externalId === connection.externalId;
}
