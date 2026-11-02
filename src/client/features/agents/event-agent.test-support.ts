import { managedAgentSchema, agentSummarySchema } from '@/shared/agent-management';

/** Canonical public shape for visual fixtures; ownership/CAS use real integration owners. */
export function eventAgentFixture() {
  const trigger = {
    id: 'saved-event:github',
    isConfigured: true,
    triggerRevision: 1,
    activationGeneration: 0,
    activationState: 'PAUSED',
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

export function eventSummaryFixture(agent: ReturnType<typeof eventAgentFixture>) {
  return agentSummarySchema.strip().parse(agent);
}
