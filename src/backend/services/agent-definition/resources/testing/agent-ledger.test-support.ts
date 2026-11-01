import { vi } from 'vitest';
import type { IntegrationDatabase } from '@/backend/testing/integration-db';
import { agentEventPayloadSchema } from '@/shared/agent-runtime';
import { agentGithubCursorSchema } from '@/shared/agent-source-state';

export const executionConfig = {
  version: 1 as const,
  provider: 'CLAUDE' as const,
  model: 'sonnet',
};

export async function createLedgerFixture(
  db: IntegrationDatabase,
  runtime: typeof import('@/backend/services/agent-definition')
) {
  const { agentSourceAccessor } = await vi.importActual<
    typeof import('@/backend/services/agent-definition/resources/agent-source.accessor')
  >('@/backend/services/agent-definition/resources/agent-source.accessor');
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.agentEvent.deleteMany();
  await db.prisma.agentConnection.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  const project = await db.prisma.project.create({
    data: {
      name: 'Factory',
      slug: crypto.randomUUID(),
      repoPath: '/repo',
      worktreeBasePath: '/worktrees',
      githubOwner: 'org',
      githubRepo: 'repo',
    },
  });
  const definition = await db.prisma.agentDefinition.create({
    data: {
      projectId: project.id,
      name: 'Investigator',
      instructions: 'Investigate bugs',
      isEnabled: true,
    },
  });
  const definitionId = definition.id;
  const connection = await db.prisma.agentConnection.create({
    data: {
      provider: 'GITHUB',
      externalId: 'gh:repo-1',
      name: 'Repo',
      sourceState: { create: { isReady: true } },
    },
  });
  const connectionId = connection.id;
  const trigger = await db.prisma.agentTrigger.create({
    data: {
      id: 'trigger-a',
      agentDefinitionId: definitionId,
      connectionId,
      type: 'GITHUB_ISSUE',
      description: 'Agent labels',
      config: { version: 1, repositoryIds: ['repo-1'], actions: ['labeled'] },
      isEnabled: true,
      activationState: 'ACTIVE',
      activationGeneration: 1,
      activationBoundary: { provider: 'GITHUB', headEventId: null, sourceOrder: 0 },
    },
  });
  const triggerId = trigger.id;
  const github = (id = 'event-1') => ({
    connectionId,
    providerEventId: id,
    payload: {
      version: 1 as const,
      provider: 'GITHUB' as const,
      repositoryId: 'repo-1',
      repositoryFullName: 'org/repo',
      action: 'labeled',
      actorId: 'human',
      creatorId: 'creator',
      occurredAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      sourceUrl: 'https://github.com/org/repo/issues/1',
      issue: { number: 1, title: 'Bug', body: 'Investigate this issue', addedLabel: 'agent' },
    },
  });

  function secondTrigger() {
    return db.prisma.agentTrigger.create({
      data: {
        id: 'trigger-b',
        agentDefinitionId: definitionId,
        connectionId,
        type: 'GITHUB_ISSUE',
        description: 'Later trigger',
        config: { version: 1, repositoryIds: ['repo-1'], actions: ['labeled'] },
        isEnabled: true,
        activationState: 'ACTIVE',
        activationGeneration: 1,
        activationBoundary: { provider: 'GITHUB', headEventId: null, sourceOrder: 0 },
      },
    });
  }
  async function event(id = 'event-1') {
    const result = await runtime.ingestEvent(github(id));
    await finalize({ connectionId, eventIds: [result.eventId] });
    return result.eventId;
  }
  async function finalize(input: { connectionId: string; eventIds: string[] }) {
    const state = await db.prisma.agentSourceState.findUnique({ where: { connectionId } });
    if (!state?.cursor) {
      await agentSourceAccessor.prepareBaseline(connectionId, null);
    }
    const current = await db.prisma.agentSourceState.findUniqueOrThrow({ where: { connectionId } });
    const boundary = agentGithubCursorSchema.parse(current.cursor).committedHeadEventId;
    const rows = await db.prisma.agentEvent.findMany({ where: { id: { in: input.eventIds } } });
    const events = input.eventIds
      .slice()
      .reverse()
      .map((id) => {
        const row = rows.find((item) => item.id === id);
        if (!row) {
          throw new Error('Test event missing');
        }
        return {
          providerEventId: row.providerEventId,
          payload: agentEventPayloadSchema.parse(row.payload),
        };
      });
    const page = {
      events: [...events, ...(boundary ? [{ providerEventId: boundary, payload: null }] : [])],
      nextPage: null,
    };
    await agentSourceAccessor.savePage(connectionId, 1, page);
    await agentSourceAccessor.savePage(connectionId, 1, page);
    return await runtime.finalizeEventOrder(input);
  }
  function evaluation(eventId: string, overrides: Record<string, unknown> = {}) {
    return runtime.recordEvaluation({
      eventId,
      triggerId,
      agentDefinitionId: definitionId,
      definitionRevision: 1,
      triggerRevision: 1,
      activationGeneration: 1,
      status: 'MATCHED',
      reasonCode: 'DETERMINISTIC_MATCH',
      explanation: 'Added label matches',
      executionConfig,
      input: { version: 1, eventId, context: [{ id: 'issue', text: 'Frozen issue context' }] },
      ...overrides,
    });
  }
  async function admit(eventId: string, overrides: Record<string, unknown> = {}) {
    const decision = await evaluation(eventId, overrides);
    if (!('evaluationId' in decision)) {
      throw new Error(JSON.stringify(decision));
    }
    return runtime.admitRun({
      evaluationId: decision.evaluationId,
      definitionRevision: 1,
      triggerRevision: 1,
      activationGeneration: 1,
    });
  }

  return {
    definitionId,
    connectionId,
    triggerId,
    github,
    event,
    finalize,
    evaluation,
    admit,
    secondTrigger,
  };
}
