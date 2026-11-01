import {
  agentActivationBoundarySchema,
  agentSourceHealthSchema,
  agentEventPayloadSchema,
  type AgentActivationBoundary,
  type AgentEventPayload,
  type AgentRuntimeReason,
} from '@/shared/agent-runtime';
import {
  agentTriggerInputSchema,
  type AgentTriggerInput,
} from '@/shared/schemas/agent-definition.schema';
import type { AgentEvent, Prisma } from '@prisma-gen/client';

export const runtimeTriggerInclude = {
  agentDefinition: { include: { project: true } },
  connection: { include: { sourceState: true } },
} as const;
export type RuntimeTrigger = Prisma.AgentTriggerGetPayload<{
  include: typeof runtimeTriggerInclude;
}>;
type Revisions = {
  definitionRevision: number;
  triggerRevision: number;
  activationGeneration: number;
};

export function sameRevisions(left: Revisions, right: Revisions) {
  return (
    left.definitionRevision === right.definitionRevision &&
    left.triggerRevision === right.triggerRevision &&
    left.activationGeneration === right.activationGeneration
  );
}
export function triggerRevisions(trigger: RuntimeTrigger): Revisions {
  return {
    definitionRevision: trigger.agentDefinition.definitionRevision,
    triggerRevision: trigger.triggerRevision,
    activationGeneration: trigger.activationGeneration,
  };
}
/** Raw durable fields: each consumer validates this projection with its boundary schema. */
export function rawTriggerInput(trigger: RuntimeTrigger) {
  return {
    type: trigger.type,
    description: trigger.description,
    filterInstructions: trigger.filterInstructions,
    isEnabled: trigger.isEnabled,
    connectionId: trigger.connectionId,
    config: trigger.config,
  };
}

/** Exact decimal provider timestamp comparison; local clocks and floating point are not boundaries. */
function laterTimestamp(value: string, boundary: string) {
  const [valueSeconds = '', valueFraction = ''] = value.split('.');
  const [boundarySeconds = '', boundaryFraction = ''] = boundary.split('.');
  if (BigInt(valueSeconds) !== BigInt(boundarySeconds)) {
    return BigInt(valueSeconds) > BigInt(boundarySeconds);
  }
  return valueFraction.padEnd(20, '0') > boundaryFraction.padEnd(20, '0');
}

function githubEligibility(
  trigger: RuntimeTrigger,
  event: AgentEvent,
  payload: Extract<AgentEventPayload, { provider: 'GITHUB' }>,
  config: AgentTriggerInput,
  boundary: AgentActivationBoundary
): AgentRuntimeReason | null {
  if (
    config.type !== 'GITHUB_ISSUE' ||
    boundary.provider !== 'GITHUB' ||
    trigger.connection?.externalId !== `gh:${payload.repositoryId}` ||
    !config.config.repositoryIds.includes(payload.repositoryId)
  ) {
    return 'SOURCE_IDENTITY_MISMATCH';
  }
  if (event.sourceOrder === null) {
    return 'SOURCE_ORDER_PENDING';
  }
  // The feed head can be a PR/unsupported control anchor with no executable event row.
  // Activation commits this ordinal only after the older API interval is finalized.
  return event.sourceOrder > boundary.sourceOrder ? null : 'BEFORE_ACTIVATION';
}

function slackEligibility(
  trigger: RuntimeTrigger,
  payload: Extract<AgentEventPayload, { provider: 'SLACK' }>,
  config: AgentTriggerInput,
  boundary: AgentActivationBoundary
): AgentRuntimeReason | null {
  if (
    config.type !== 'SLACK_MESSAGE' ||
    boundary.provider !== 'SLACK' ||
    trigger.connection?.externalId !== payload.workspaceId ||
    boundary.workspaceId !== payload.workspaceId ||
    boundary.appId !== payload.appId ||
    !config.config.channelIds.includes(payload.channelId)
  ) {
    return 'SOURCE_IDENTITY_MISMATCH';
  }
  const channel = boundary.channels.find((entry) => entry.channelId === payload.channelId);
  return channel && laterTimestamp(payload.eventTs, channel.eventTs) ? null : 'BEFORE_ACTIVATION';
}

export function eventEligibility(
  trigger: RuntimeTrigger,
  event: AgentEvent,
  now: Date
): AgentRuntimeReason | null {
  if (
    event.payloadExpiresAt <= now ||
    event.occurredAt.getTime() <= now.getTime() - 30 * 24 * 60 * 60 * 1000
  ) {
    return 'EVENT_EXPIRED';
  }
  const parsed = agentEventPayloadSchema.safeParse(event.payload);
  const boundary = agentActivationBoundarySchema.safeParse(trigger.activationBoundary);
  const settings = agentTriggerInputSchema.safeParse(rawTriggerInput(trigger));
  if (!(parsed.success && boundary.success && settings.success)) {
    return 'INVALID_STORED_DATA';
  }
  const payload = parsed.data;
  const connection = trigger.connection;
  if (
    !connection ||
    event.connectionId !== connection.id ||
    connection.provider !== payload.provider ||
    boundary.data.provider !== payload.provider
  ) {
    return 'OWNERSHIP_MISMATCH';
  }
  return payload.provider === 'GITHUB'
    ? githubEligibility(trigger, event, payload, settings.data, boundary.data)
    : slackEligibility(trigger, payload, settings.data, boundary.data);
}

export function permanentRuntimeStateReason(trigger: RuntimeTrigger): AgentRuntimeReason | null {
  if (trigger.type === 'SCHEDULE') {
    return 'UNSUPPORTED_TRIGGER';
  }
  if (trigger.agentDefinition.project.isArchived) {
    return 'PROJECT_ARCHIVED';
  }
  if (!trigger.agentDefinition.isEnabled) {
    return 'DEFINITION_DISABLED';
  }
  if (!trigger.isEnabled || trigger.activationState !== 'ACTIVE') {
    return 'TRIGGER_DISABLED';
  }
  if (
    !trigger.connection?.isEnabled ||
    (trigger.connection.provider === 'SLACK' && !trigger.connection.credentialsEncrypted)
  ) {
    return 'CONNECTION_UNAVAILABLE';
  }
  const health = agentSourceHealthSchema.safeParse(trigger.connection?.sourceState?.health);
  if (!health.success && trigger.connection?.sourceState?.health != null) {
    return 'INVALID_STORED_DATA';
  }
  if (health.success && health.data.state === 'RECOVERY_REQUIRED') {
    return 'SOURCE_RECOVERY_REQUIRED';
  }
  return null;
}

export function runtimeStateReason(trigger: RuntimeTrigger): AgentRuntimeReason | null {
  const permanent = permanentRuntimeStateReason(trigger);
  if (permanent) {
    return permanent;
  }
  return trigger.connection?.sourceState?.isReady ? null : 'CONNECTION_UNAVAILABLE';
}
