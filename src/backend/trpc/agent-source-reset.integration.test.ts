import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let agentRouter: typeof import('./agent.trpc').agentRouter;
let createAgentManagement: typeof import('@/backend/orchestration/agents/agent-management.orchestrator').createAgentManagement;
let runtime: typeof import('@/backend/services/agent-definition');
let workspace: typeof import('@/backend/services/workspace');
let caller: ReturnType<typeof agentRouter.createCaller>;
let projectId: string;
let connectionId: string;

function makeServices() {
  return {
    agentManagementService: new runtime.AgentManagementService(),
    agentProposalService: new runtime.AgentProposalService(),
    projectManagementService: workspace.projectManagementService,
    workspaceDataService: workspace.workspaceDataService,
    slackConnectionService: new runtime.SlackConnectionService(
      { encrypt: (value) => value, decrypt: (value) => value },
      () => Promise.reject(new Error('Unexpected Slack call'))
    ),
    githubCLIService: {
      getAgentRepository: () => Promise.reject(new Error('Unexpected GitHub call')),
    },
    sessionProviderResolverService: {
      resolveDefaultsForWorkspaceCreation: async (
        provider?: 'CLAUDE' | 'CODEX',
        model?: string
      ) => ({ provider: provider ?? 'CLAUDE', model: model ?? 'sonnet' }),
    },
    userSettingsQueryService: {
      get: async () => ({ defaultClaudeReasoningEffort: null, defaultCodexReasoningEffort: null }),
    },
    sessionConfigService: {
      getLaunchOptions: () => Promise.reject(new Error('Unexpected launch options call')),
    },
  };
}
beforeAll(async () => {
  db = await createIntegrationDatabase();
  ({ agentRouter } = await vi.importActual<typeof import('./agent.trpc')>('./agent.trpc'));
  ({ createAgentManagement } = await vi.importActual<
    typeof import('@/backend/orchestration/agents/agent-management.orchestrator')
  >('@/backend/orchestration/agents/agent-management.orchestrator'));
  runtime = await vi.importActual<typeof import('@/backend/services/agent-definition')>(
    '@/backend/services/agent-definition'
  );
  workspace = await vi.importActual<typeof import('@/backend/services/workspace')>(
    '@/backend/services/workspace'
  );
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.project.deleteMany();
  await db.prisma.agentConnection.deleteMany();
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
  projectId = project.id;
  const connection = await db.prisma.agentConnection.create({
    data: {
      provider: 'GITHUB',
      externalId: 'gh:repo-1',
      name: 'org/repo',
      sourceState: {
        create: {
          lastSourceOrder: 7,
          health: {
            state: 'RECOVERY_REQUIRED',
            reasonCode: 'GITHUB_CONTINUITY_LOST',
            updatedAt: new Date().toISOString(),
          },
        },
      },
    },
  });
  connectionId = connection.id;
  await db.prisma.agentDefinition.create({
    data: {
      projectId,
      name: 'Investigator',
      instructions: 'Investigate',
      isEnabled: true,
      triggers: {
        create: {
          type: 'GITHUB_ISSUE',
          connectionId,
          description: 'Agent labels',
          config: { version: 1, repositoryIds: ['repo-1'], actions: ['labeled'] },
          isConfigured: true,
          isEnabled: true,
          activationState: 'ACTIVE',
          activationGeneration: 1,
          activationBoundary: { provider: 'GITHUB', headEventId: null, sourceOrder: 0 },
        },
      },
    },
  });
  const services = makeServices();
  caller = agentRouter.createCaller({
    appContext: {
      services: { ...services, agentManagement: createAgentManagement(() => services) },
    },
  } as never);
});

it('resets a fenced source for a project that uses it', async () => {
  await expect(caller.resetSource({ projectId, connectionId })).resolves.toEqual({
    connectionId,
    pausedTriggerCount: 1,
    cancelledRunCount: 0,
  });
  expect(
    await db.prisma.agentSourceState.findUniqueOrThrow({ where: { connectionId } })
  ).toMatchObject({
    lastSourceOrder: 7,
    cursor: null,
    isReady: false,
    health: { state: 'DISCONNECTED', reasonCode: 'GITHUB_SOURCE_RESET' },
  });
  expect(await db.prisma.agentTrigger.findFirstOrThrow()).toMatchObject({
    activationState: 'PAUSED',
    isEnabled: false,
  });
});

it('hides sources the project does not use and refuses sources that need no recovery', async () => {
  const foreign = await db.prisma.project.create({
    data: { name: 'Foreign', slug: crypto.randomUUID(), repoPath: '/f', worktreeBasePath: '/fw' },
  });
  await expect(caller.resetSource({ projectId: foreign.id, connectionId })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  await db.prisma.agentSourceState.update({
    where: { connectionId },
    data: { health: { state: 'READY', reasonCode: null, updatedAt: new Date().toISOString() } },
  });
  await expect(caller.resetSource({ projectId, connectionId })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
  await expect(
    caller.resetSource({ projectId, connectionId, extra: true } as never)
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});
