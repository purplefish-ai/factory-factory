import { ApplicationError } from '@/backend/lib/application-error';
import {
  type agentManagementAccessor,
  managementCursorSchema,
  type ManagementCursor,
} from '@/backend/services/agent-definition/resources/agent-management.accessor';
import {
  agentCapabilitySchema,
  agentSummarySchema,
  managedAgentSchema,
  managedTriggerSchema,
  savedAgentSpecificationSchema,
  type AgentCapability,
} from '@/shared/agent-management';
import { agentSourceHealthSchema } from '@/shared/agent-runtime';
import {
  agentExecutionConfigSchema,
  agentTriggerInputSchema,
  type AgentTriggerInput,
} from '@/shared/schemas/agent-definition.schema';

export function triggerCapability(
  trigger: AgentTriggerInput | null,
  verified = false
): AgentCapability {
  let reasonCode: AgentCapability['reasonCode'] = 'SUPPORTED';
  if (!trigger) {
    reasonCode = 'INVALID_STORED_DATA';
  } else if (
    (trigger.type === 'GITHUB_ISSUE' && trigger.config.creatorIds) ||
    (trigger.type === 'SLACK_MESSAGE' && trigger.config.senderIds)
  ) {
    reasonCode = 'UNSUPPORTED_ACTOR_FILTER';
  } else if (trigger.filterInstructions) {
    reasonCode = 'UNSUPPORTED_SEMANTIC_FILTER';
  } else if (trigger.type === 'SCHEDULE') {
    reasonCode = 'UNSUPPORTED_SCHEDULE';
  } else if (trigger.type === 'SLACK_MESSAGE') {
    reasonCode = 'SLACK_INTAKE_UNAVAILABLE';
  } else if (trigger.config.actions.some((action) => action !== 'labeled')) {
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
  UNSUPPORTED_SCHEDULE: 'Use scheduled agents for time-based tasks.',
  SLACK_INTAKE_UNAVAILABLE: 'Slack event intake is not available yet.',
  UNSUPPORTED_GITHUB_ACTION: 'Only GitHub labeled events are supported.',
  UNSUPPORTED_SEMANTIC_FILTER: 'Semantic event filtering is not available yet.',
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
  function triggerProjection(row: (typeof retained)[number]) {
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
    return managedTriggerSchema.parse({
      id: row.id,
      isConfigured: row.isConfigured,
      triggerRevision: row.triggerRevision,
      activationGeneration: row.activationGeneration,
      activationState: row.activationState,
      isEnabled: row.isEnabled,
      configuration,
      capability: membershipCapability(row, unknown, configuration),
      sourceName: row.connection ? row.connection.name.slice(0, 500) : row.connectionId,
      sourceHealth: health.success ? health.data : null,
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

function membershipCapability(
  row: Awaited<ReturnType<typeof agentManagementAccessor.get>>['retained'][number],
  unknown: boolean,
  configuration: AgentTriggerInput | null
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
  return triggerCapability(configuration);
}
