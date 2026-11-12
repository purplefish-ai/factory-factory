import { managedAgentSchema, agentSummarySchema } from '@/shared/agent-management';
import { agentProjectSourcesSchema } from '@/shared/agent-validation';

/** Canonical public shape for visual fixtures; ownership/CAS use real integration owners. */
export function eventAgentFixture() {
  const trigger = {
    id: 'saved-event:github',
    isConfigured: true,
    triggerRevision: 1,
    activationGeneration: 0,
    activationState: 'PAUSED',
    pausedReasonCode: null,
    isEnabled: false,
    configuration: {
      type: 'GITHUB_ISSUE',
      connectionId: 'github-connection',
      description: 'Investigate labeled issues',
      filterInstructions: null,
      config: { version: 1, repositoryIds: ['repo-1'], actions: ['labeled'], labels: ['agent'] },
    },
    capability: {
      status: 'SUPPORTED',
      reasonCode: 'SUPPORTED',
      explanation: 'This GitHub label configuration is supported.',
    },
    sourceName: 'example/repo',
    sourceHealth: null,
  };
  return managedAgentSchema.parse({
    id: 'event-agent',
    projectId: 'owner',
    name: 'Investigate labeled issues',
    instructions: 'Investigate labeled issues and propose a focused fix.',
    managementRevision: 2,
    definitionRevision: 1,
    isEnabled: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    executionConfig: { version: 1 },
    configurationMembership: 'KNOWN',
    specification: {
      name: 'Investigate labeled issues',
      instructions: 'Investigate labeled issues and propose a focused fix.',
      executionConfig: { version: 1 },
      triggers: [{ ...trigger.configuration, id: trigger.id }],
    },
    configuredTriggers: [trigger],
    retainedTriggers: [],
    retainedNextCursor: null,
  });
}

type EventAgentFixture = ReturnType<typeof eventAgentFixture>;
type EventTriggerFixture = EventAgentFixture['configuredTriggers'][number];

/**
 * The exact fields the backend writes for each trigger state: `pauseTriggers`
 * and `startTrigger` store `isEnabled: false` (PAUSED and STARTING), and only
 * `activate` stores `isEnabled: true`, together with ACTIVE. A reason is kept
 * only on a paused trigger whose start failed or expired.
 */
export function triggerInBackendState(
  trigger: EventTriggerFixture,
  state: 'PAUSED' | 'STARTING' | 'ACTIVE',
  pausedReasonCode: EventTriggerFixture['pausedReasonCode'] = null
): EventTriggerFixture {
  return {
    ...trigger,
    isEnabled: state === 'ACTIVE',
    activationState: state,
    pausedReasonCode: state === 'PAUSED' ? pausedReasonCode : null,
  };
}

/** `pauseTriggers`: PAUSED on a new generation, with no reason. */
function pausedOnNewGeneration(trigger: EventTriggerFixture): EventTriggerFixture {
  return {
    ...triggerInBackendState(trigger, 'PAUSED'),
    activationGeneration: trigger.activationGeneration + 1,
  };
}

/**
 * What `automation.enable` returns: the definition is enabled and its
 * revision advances at once; each supported trigger that is not already
 * listening starts a new STARTING generation; an unsupported trigger that is
 * not paused is paused on a new generation, and every unsupported trigger
 * loses its activation reason. Retained records are untouched.
 */
export function backendEnable(agent: EventAgentFixture): EventAgentFixture {
  return {
    ...agent,
    isEnabled: true,
    managementRevision: agent.managementRevision + 1,
    configuredTriggers: agent.configuredTriggers.map((trigger) => {
      if (trigger.capability.status !== 'SUPPORTED') {
        return trigger.activationState === 'PAUSED'
          ? { ...trigger, pausedReasonCode: null }
          : pausedOnNewGeneration(trigger);
      }
      if (trigger.activationState === 'ACTIVE' && trigger.isEnabled) {
        return trigger;
      }
      return {
        ...triggerInBackendState(trigger, 'STARTING'),
        activationGeneration: trigger.activationGeneration + 1,
      };
    }),
  };
}

/** What the poll-cycle job writes once a starting trigger's baseline lands. */
export function backendActivate(agent: EventAgentFixture): EventAgentFixture {
  return {
    ...agent,
    configuredTriggers: agent.configuredTriggers.map((trigger) =>
      trigger.activationState === 'STARTING' ? triggerInBackendState(trigger, 'ACTIVE') : trigger
    ),
  };
}

/**
 * What `automation.pause` returns: definition disabled, and every trigger of
 * the definition, configured or retained, paused on a new generation.
 */
export function backendPause(agent: EventAgentFixture): EventAgentFixture {
  return {
    ...agent,
    isEnabled: false,
    managementRevision: agent.managementRevision + 1,
    configuredTriggers: agent.configuredTriggers.map(pausedOnNewGeneration),
    retainedTriggers: agent.retainedTriggers.map(pausedOnNewGeneration),
  };
}

/**
 * How an automation reads after `automation.resetSource`: every trigger on the
 * source, configured or retained, is paused on a new generation and the source
 * reads reset. The definition keeps its enabled flag and management revision.
 */
export function backendResetSource(
  agent: EventAgentFixture,
  connectionId: string,
  updatedAt: string
): EventAgentFixture {
  const reset = (trigger: EventTriggerFixture): EventTriggerFixture =>
    trigger.configuration?.connectionId === connectionId
      ? {
          ...pausedOnNewGeneration(trigger),
          sourceHealth: { state: 'DISCONNECTED', reasonCode: 'GITHUB_SOURCE_RESET', updatedAt },
        }
      : trigger;
  return {
    ...agent,
    configuredTriggers: agent.configuredTriggers.map(reset),
    retainedTriggers: agent.retainedTriggers.map(reset),
  };
}

export function eventSummaryFixture(agent: ReturnType<typeof eventAgentFixture>) {
  return agentSummarySchema.strip().parse(agent);
}

/** Frontend-only discovery pages; credentials/native/source ports are never acquired. */
export function eventProjectSourcesFixture(
  projectId: string,
  connectionId?: string,
  cursor?: string
) {
  const channels =
    cursor === 'fixture-page-2'
      ? [
          { id: 'fixture-shared', name: 'Fixture shared channel' },
          { id: 'fixture-two', name: 'Fixture channel two' },
        ]
      : cursor === 'fixture-page-3'
        ? [{ id: 'fixture-three', name: 'Fixture channel three' }]
        : [
            { id: 'fixture-one', name: 'Fixture channel one' },
            { id: 'fixture-shared', name: 'Fixture shared channel' },
          ];
  return agentProjectSourcesSchema.parse({
    project: { id: projectId, name: 'Frontend fixture' },
    slack: {
      connections: [
        {
          id: 'fixture-slack',
          name: 'Fixture Slack',
          workspaceId: 'fixture-workspace',
          isEnabled: true,
          hasCredentials: false,
          hasAppToken: false,
          appId: null,
        },
      ],
      ...(connectionId === 'fixture-slack'
        ? {
            channels,
            nextCursor:
              cursor === 'fixture-page-3'
                ? null
                : cursor === 'fixture-page-2'
                  ? 'fixture-page-3'
                  : 'fixture-page-2',
          }
        : {}),
    },
    github: { error: 'Source discovery is unavailable in this frontend fixture.' },
  });
}
