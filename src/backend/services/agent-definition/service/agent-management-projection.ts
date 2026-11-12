import { ApplicationError } from '@/backend/lib/application-error';
import {
  type agentManagementAccessor,
  managementCursorSchema,
  type ManagementCursor,
} from '@/backend/services/agent-definition/resources/agent-management.accessor';
import { slackVerificationMessage } from '@/backend/services/agent-definition/resources/slack-verification';
import { configService } from '@/backend/services/config.service';
import {
  agentCapabilitySchema,
  agentPausedReasonCodeSchema,
  agentSummarySchema,
  managedAgentSchema,
  managedTriggerSchema,
  savedAgentSpecificationSchema,
  type AgentCapability,
  type AgentPendingVerification,
} from '@/shared/agent-management';
import {
  agentSlackPendingActivationSchema,
  agentSourceHealthSchema,
  isAgentGithubExecutableAction,
} from '@/shared/agent-runtime';
import type { SessionProvider } from '@/shared/core/enums';
import {
  agentExecutionConfigSchema,
  agentTriggerInputSchema,
  type AgentTriggerInput,
} from '@/shared/schemas/agent-definition.schema';
import { semanticFilterSupported } from './semantic-filter-gate';

/**
 * Whether a Slack trigger could listen: intake must be switched on
 * (`slackIntakeEnabled`) and its connection must have an app-level token.
 */
export type SlackIntakeReadiness = 'INTAKE_OFF' | 'APP_TOKEN_REQUIRED' | 'READY';

/**
 * `provider` is the automation's provider; undefined means it inherits the user
 * default, so natural-language filters need every provider's classifier proven.
 */
export function triggerCapability(
  trigger: AgentTriggerInput | null,
  verified = false,
  provider?: SessionProvider,
  slack: SlackIntakeReadiness = 'INTAKE_OFF'
): AgentCapability {
  let reasonCode: AgentCapability['reasonCode'] = 'SUPPORTED';
  if (!trigger) {
    reasonCode = 'INVALID_STORED_DATA';
  } else if (
    (trigger.type === 'GITHUB_ISSUE' && trigger.config.creatorIds) ||
    (trigger.type === 'SLACK_MESSAGE' && trigger.config.senderIds)
  ) {
    reasonCode = 'UNSUPPORTED_ACTOR_FILTER';
  } else if (trigger.filterInstructions && !semanticFilterSupported(provider)) {
    reasonCode = 'UNSUPPORTED_SEMANTIC_FILTER';
  } else if (trigger.type === 'SCHEDULE') {
    reasonCode = 'UNSUPPORTED_SCHEDULE';
  } else if (trigger.type === 'SLACK_MESSAGE' && slack === 'INTAKE_OFF') {
    reasonCode = 'SLACK_INTAKE_UNAVAILABLE';
  } else if (trigger.type === 'SLACK_MESSAGE' && slack === 'APP_TOKEN_REQUIRED') {
    reasonCode = 'SLACK_APP_TOKEN_REQUIRED';
  } else if (
    trigger.type === 'GITHUB_ISSUE' &&
    trigger.config.actions.some((action) => !isAgentGithubExecutableAction(action))
  ) {
    reasonCode = 'UNSUPPORTED_GITHUB_ACTION';
  } else if (!verified) {
    reasonCode = 'SOURCE_UNVERIFIED';
  }
  return capability(reasonCode);
}
const explanations: Record<AgentCapability['reasonCode'], string> = {
  SUPPORTED: 'The trigger settings and selected source are supported.',
  UNKNOWN_MEMBERSHIP: 'Save the complete configuration before activation can be considered.',
  REMOVED_TRIGGER: 'This event is retained for history and is not configured.',
  INVALID_STORED_DATA: 'Stored configuration is unavailable.',
  UNSUPPORTED_SCHEDULE: 'Use scheduled automations for time-based tasks.',
  SLACK_INTAKE_UNAVAILABLE: 'Slack event intake is not available yet.',
  SLACK_APP_TOKEN_REQUIRED:
    "Add this Slack workspace's app-level token in Settings > Integrations > Slack, then enable again.",
  UNSUPPORTED_GITHUB_ACTION: 'Only GitHub labeled and reopened events are supported.',
  UNSUPPORTED_SEMANTIC_FILTER:
    "Natural-language filters are not available for this automation's provider yet.",
  UNSUPPORTED_ACTOR_FILTER:
    'Actor restrictions require actor discovery, which is not available yet.',
  SOURCE_UNVERIFIED: 'Validate the draft to verify current source access.',
  SOURCE_UNAVAILABLE: 'The selected source is unavailable.',
};
export function capability(reasonCode: AgentCapability['reasonCode']): AgentCapability {
  return agentCapabilitySchema.parse({
    reasonCode,
    explanation: explanations[reasonCode],
    status:
      reasonCode === 'SUPPORTED'
        ? 'SUPPORTED'
        : reasonCode.startsWith('UNSUPPORTED_')
          ? 'UNSUPPORTED'
          : 'UNAVAILABLE',
  });
}
export function readManagementCursor(
  value: string | undefined,
  scope: Pick<ManagementCursor, 'projectId' | 'agentId' | 'kind'>
) {
  if (!value) {
    return undefined;
  }
  try {
    const cursor = managementCursorSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    );
    if (
      cursor.projectId !== scope.projectId ||
      cursor.agentId !== scope.agentId ||
      cursor.kind !== scope.kind
    ) {
      throw new Error('scope');
    }
    return cursor;
  } catch {
    throw new ApplicationError('INVALID_INPUT', 'Invalid history cursor.');
  }
}
export function nextManagementCursor(
  rows: { id: string; createdAt: Date }[],
  limit: number,
  scope: Pick<ManagementCursor, 'projectId' | 'agentId' | 'kind'>
) {
  const last = rows[limit - 1];
  return rows.length > limit && last
    ? Buffer.from(
        JSON.stringify({ ...scope, id: last.id, createdAt: last.createdAt.toISOString() })
      ).toString('base64url')
    : null;
}
export function managementSummary(
  row: Awaited<ReturnType<typeof agentManagementAccessor.get>>['definition']
) {
  return agentSummarySchema.parse({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    managementRevision: row.managementRevision,
    definitionRevision: row.definitionRevision,
    isEnabled: row.isEnabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
export function managementProjection(
  data: Awaited<ReturnType<typeof agentManagementAccessor.get>>
) {
  const { definition, unknown, configured, retained } = data;
  const provider = agentExecutionConfigSchema.safeParse(definition.executionConfig).data?.provider;
  function triggerProjection(row: TriggerRow) {
    const parsed = agentTriggerInputSchema.safeParse({
      type: row.type,
      connectionId: row.connectionId,
      config: row.config,
      description: row.description,
      filterInstructions: row.filterInstructions,
      isEnabled: false,
    });
    const configuration = parsed.success ? parsed.data : null;
    const health = agentSourceHealthSchema.safeParse(row.connection?.sourceState?.health);
    const pausedReason = agentPausedReasonCodeSchema.safeParse(row.pausedReasonCode);
    return managedTriggerSchema.parse({
      id: row.id,
      isConfigured: row.isConfigured,
      triggerRevision: row.triggerRevision,
      activationGeneration: row.activationGeneration,
      activationState: row.activationState,
      pausedReasonCode: pausedReason.success ? pausedReason.data : null,
      isEnabled: row.isEnabled,
      configuration,
      capability: membershipCapability(row, unknown, configuration, provider),
      sourceName: row.connection ? row.connection.name.slice(0, 500) : row.connectionId,
      sourceHealth: health.success ? health.data : null,
      pendingVerification: pendingVerification(row),
    });
  }
  const execution = agentExecutionConfigSchema.safeParse(definition.executionConfig);
  const configuredTriggers = configured.map(triggerProjection);
  const specification = savedAgentSpecificationSchema.safeParse({
    name: definition.name,
    instructions: definition.instructions,
    executionConfig: definition.executionConfig,
    triggers: configuredTriggers.map((row) => ({ ...row.configuration, id: row.id })),
  });
  return managedAgentSchema.parse({
    ...managementSummary(definition),
    instructions: definition.instructions,
    executionConfig: execution.success ? execution.data : null,
    configurationMembership: unknown ? 'UNKNOWN' : 'KNOWN',
    specification: !unknown && specification.success ? specification.data : null,
    configuredTriggers,
    retainedTriggers: retained.slice(0, 100).map(triggerProjection),
    retainedNextCursor: nextManagementCursor(retained, 100, {
      projectId: definition.projectId,
      agentId: definition.id,
      kind: 'retained',
    }),
  });
}

type TriggerRow = Awaited<ReturnType<typeof agentManagementAccessor.get>>['retained'][number];

/** Bot and app-level tokens are saved and cleared with the app ID, so the ID stands for both. */
function slackReadiness(row: TriggerRow): SlackIntakeReadiness {
  if (!configService.getAgentRuntimeLimits().slackIntakeEnabled) {
    return 'INTAKE_OFF';
  }
  return row.connection?.isEnabled && row.connection.appId ? 'READY' : 'APP_TOKEN_REQUIRED';
}

function membershipCapability(
  row: TriggerRow,
  unknown: boolean,
  configuration: AgentTriggerInput | null,
  provider: SessionProvider | undefined
) {
  if (unknown) {
    return capability('UNKNOWN_MEMBERSHIP');
  }
  if (row.isConfigured === false) {
    return capability('REMOVED_TRIGGER');
  }
  if (row.connectionId && !row.connection?.isEnabled) {
    return capability('SOURCE_UNAVAILABLE');
  }
  // A read cannot recheck source access; Enable does, and a disabled connection is reported
  // above. Treating the source as unverified here would show every trigger as unable to run.
  return triggerCapability(configuration, true, provider, slackReadiness(row));
}

/** The test message a STARTING Slack generation waits for, and which channels have it. */
function pendingVerification(row: TriggerRow): AgentPendingVerification | null {
  const pending = agentSlackPendingActivationSchema.safeParse(row.pendingActivation);
  if (
    row.activationState !== 'STARTING' ||
    !pending.success ||
    pending.data.activationGeneration !== row.activationGeneration
  ) {
    return null;
  }
  return {
    message: slackVerificationMessage(pending.data.nonce),
    expiresAt: pending.data.expiresAt,
    channels: pending.data.channels.map((channel) => ({
      channelId: channel.channelId,
      name: channel.name,
      verified: channel.eventTs !== null,
    })),
  };
}
