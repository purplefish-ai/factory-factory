import { agentValidatedIntentSchema } from '@/shared/agent-management';
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
import { isSlackVerificationText } from './slack/slack-verification';

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

/**
 * Exact decimal comparison of Slack `ts` strings (`"1731430000.000100"`); local
 * clocks and floating point are never boundaries. Negative when `left` is earlier.
 */
export function compareSlackTimestamps(left: string, right: string) {
  const [leftSeconds = '', leftFraction = ''] = left.split('.');
  const [rightSeconds = '', rightFraction = ''] = right.split('.');
  if (BigInt(leftSeconds) !== BigInt(rightSeconds)) {
    return BigInt(leftSeconds) > BigInt(rightSeconds) ? 1 : -1;
  }
  const [a, b] = [leftFraction.padEnd(20, '0'), rightFraction.padEnd(20, '0')];
  return a === b ? 0 : a > b ? 1 : -1;
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
  if (!channel || compareSlackTimestamps(payload.eventTs, channel.eventTs) <= 0) {
    return 'BEFORE_ACTIVATION';
  }
  // A test message posted to turn on any Slack automation never starts a run.
  return isSlackVerificationText(payload.text) ? 'VERIFICATION_MESSAGE' : null;
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

/** Enable persists the intent it validated; any later execution edit makes it stale. */
export function hasCurrentValidatedIntent(definition: {
  definitionRevision: number;
  validatedIntent: unknown;
}) {
  const intent = agentValidatedIntentSchema.safeParse(definition.validatedIntent);
  return intent.success && intent.data.definitionRevision === definition.definitionRevision;
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
  if (!trigger.isEnabled || trigger.activationState !== 'ACTIVE' || trigger.isConfigured !== true) {
    return 'TRIGGER_DISABLED';
  }
  if (!hasCurrentValidatedIntent(trigger.agentDefinition)) {
    return 'EXECUTION_NOT_VALIDATED';
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
