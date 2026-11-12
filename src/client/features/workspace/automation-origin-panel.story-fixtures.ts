import { agentRunHistorySchema, agentWorkspaceOriginSchema } from '@/shared/agent-history';
import { managedAgentSchema } from '@/shared/agent-management';

/** The run, automation and project an event-run workspace's Runs tab reads. */
export function automationOriginFixture({
  projectId = 'owner',
  workspaceId = 'workspace-pr',
}: { projectId?: string; workspaceId?: string } = {}) {
  const run = agentRunHistorySchema.parse({
    id: 'run-pr',
    context: { state: 'RETAINED' },
    agentId: 'event-agent',
    triggerId: 'saved-event:github',
    eventId: 'event-pr',
    createdAt: '2026-11-10T09:00:00.000Z',
    startedAt: '2026-11-10T09:00:05.000Z',
    completedAt: '2026-11-10T09:24:00.000Z',
    status: 'PR_CREATED',
    launchPhase: 'FINISHED',
    reasonCode: null,
    attemptCount: 1,
    attemptGeneration: 1,
    nextAttemptAt: null,
    expiresAt: null,
    setupDeadlineAt: null,
    turnDeadlineAt: null,
    preparation: null,
    delivery: null,
    initialOutcome: { result: 'COMPLETED', stopReason: 'end_turn' },
    result: {
      version: 1,
      summary: 'Fixed the flaky retry test.',
      pullRequests: [{ url: 'https://github.com/example/repo/pull/42', number: 42 }],
    },
    reservedWorkspaceId: workspaceId,
    reservedSessionId: 'session-pr',
    workspaceId,
    workspaceState: 'LIVE',
  });
  const origin = agentWorkspaceOriginSchema.parse({
    origin: {
      projectId,
      workspaceId,
      runId: run.id,
      workspaceState: 'LIVE',
    },
    run,
  });
  const agent = managedAgentSchema.parse({
    id: 'event-agent',
    projectId,
    name: 'Investigate labeled issues',
    instructions: 'Investigate labeled issues and propose a focused fix.',
    managementRevision: 2,
    definitionRevision: 1,
    isEnabled: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    executionConfig: { version: 1 },
    configurationMembership: 'KNOWN',
    specification: null,
    configuredTriggers: [],
    retainedTriggers: [],
    retainedNextCursor: null,
  });
  return { origin, agent, project: { id: projectId, slug: 'demo', name: 'Demo' } };
}
