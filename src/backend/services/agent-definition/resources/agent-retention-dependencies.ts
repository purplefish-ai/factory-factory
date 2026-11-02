import {
  agentActivationBoundarySchema,
  agentClassifierIdentitySchema,
  agentEvaluationFailureSnapshotSchema,
  agentEvaluationSnapshotSchema,
  agentEventPayloadSchema,
  agentPendingActivationSchema,
  agentSourceHealthSchema,
} from '@/shared/agent-runtime';
import { agentGithubCursorSchema } from '@/shared/agent-source-state';
import { agentTriggerInputSchema } from '@/shared/schemas/agent-definition.schema';
import type {
  AgentConnection,
  AgentEvent,
  AgentEvaluation,
  AgentSourceState,
  AgentTrigger,
  Prisma,
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
  const triggers = await tx.agentTrigger.findMany({
    where: { connectionId: event.connectionId },
    take: limit + 1,
    orderBy: { id: 'asc' },
  });
  assertCurrent();
  if (triggers.length > limit) {
    return 'DEPENDENCY_LIMIT';
  }
  for (const trigger of triggers) {
    const reason = triggerDependency(trigger);
    if (reason) {
      return reason;
    }
  }
  const connection = await tx.agentConnection.findUnique({
    where: { id: event.connectionId },
    include: { sourceState: true },
  });
  assertCurrent();
  return sourceDependency(connection, event, identity);
}

function triggerDependency(trigger: AgentTrigger): RetentionReason | null {
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
  const provider = trigger.type === 'GITHUB_ISSUE' ? 'GITHUB' : 'SLACK';
  if (
    !settings.success ||
    (needsBoundary && !(boundary.success && boundary.data.provider === provider)) ||
    !validPendingActivation(trigger)
  ) {
    return 'INVALID_STORED_DATA';
  }
  return null;
}

function validPendingActivation(trigger: AgentTrigger) {
  if (trigger.pendingActivation === null) {
    return true;
  }
  const pending = agentPendingActivationSchema.safeParse(trigger.pendingActivation);
  return (
    pending.success &&
    pending.data.connectionId === trigger.connectionId &&
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
  if (event.payload !== null && !agentEventPayloadSchema.safeParse(event.payload).success) {
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
