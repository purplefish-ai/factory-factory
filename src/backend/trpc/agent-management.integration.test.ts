import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
let createAgentManagement: typeof import('@/backend/orchestration/agent-management.orchestrator').createAgentManagement;
let createContext: typeof import('./trpc').createContext;
let agentRouter: typeof import('./agent.trpc').agentRouter;

let db: IntegrationDatabase;
let runtime: typeof import('@/backend/services/agent-definition');
let workspace: typeof import('@/backend/services/workspace');
let projectId: string;
let connectionId: string;
let repository: ReturnType<
  typeof vi.fn<(name: string) => Promise<{ id: string; name: string; labels: string[] }>>
>;
let native: ReturnType<
  typeof vi.fn<() => Promise<import('@/shared/session-launch').SessionLaunchOptions>>
>;
let services: ReturnType<typeof makeServices>;
let caller: ReturnType<typeof agentRouter.createCaller>;
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
    githubCLIService: { getAgentRepository: async (name: string) => repository(name) },
    sessionProviderResolverService: {
      resolveDefaultsForWorkspaceCreation: async () => ({
        provider: 'CLAUDE' as const,
        model: 'sonnet',
      }),
    },
    userSettingsQueryService: {
      get: async () => ({
        defaultClaudeReasoningEffort: 'high',
        defaultCodexReasoningEffort: null,
      }),
    },
    sessionConfigService: { getLaunchOptions: async () => native() },
    configService: {
      getCorsConfig: () => ({
        allowedOrigins: ['http://localhost:3000'],
        trustedLocalCidrs: [],
        trustProxyHeaders: false,
        disableCorsChecks: false,
      }),
    },
  };
}
beforeAll(async () => {
  db = await createIntegrationDatabase();
  ({ agentRouter } = await vi.importActual<typeof import('./agent.trpc')>('./agent.trpc'));
  ({ createContext } = await vi.importActual<typeof import('./trpc')>('./trpc'));
  ({ createAgentManagement } = await vi.importActual<
    typeof import('@/backend/orchestration/agent-management.orchestrator')
  >('@/backend/orchestration/agent-management.orchestrator'));
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
  await db.prisma.workspace.deleteMany();
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
    data: { provider: 'GITHUB', externalId: 'gh:repo-1', name: 'org/repo' },
  });
  connectionId = connection.id;
  repository = vi.fn(async () => ({ id: 'repo-1', name: 'org/repo', labels: ['agent'] }));
  native = vi.fn(async () => ({
    provider: 'CLAUDE',
    model: 'claude-sonnet-4-6',
    reasoning: { options: [{ value: 'high', label: 'High' }], defaultValue: 'high' },
    planMode: { supported: true, selected: false },
  }));
  services = makeServices();
  caller = agentRouter.createCaller({
    appContext: {
      services: { ...services, agentManagement: createAgentManagement(() => services) },
    },
  } as never);
});
function specification() {
  return {
    name: 'Investigator',
    instructions: 'Investigate',
    executionConfig: { version: 1 as const },
    triggers: [
      {
        type: 'GITHUB_ISSUE' as const,
        connectionId,
        description: 'Label',
        filterInstructions: null,
        isEnabled: false as const,
        config: {
          version: 1 as const,
          repositoryIds: ['repo-1'],
          actions: ['labeled' as const],
          labels: ['agent'],
        },
      },
    ],
  };
}
async function save() {
  const row = await db.prisma.workspace.create({ data: { projectId, name: 'Author' } });
  const draft = await services.agentProposalService.propose({
    workspaceId: row.id,
    specification: specification(),
  });
  const accepted = await services.agentProposalService.create({
    workspaceId: row.id,
    proposalId: draft.id,
    revision: 1,
    specification: draft.specification,
  });
  return { projectId, agentId: accepted.agentDefinitionId! };
}
it('offers project-owned discovery and truthful explicit preview without native calls on ordinary reads', async () => {
  const owner = await save();
  const sources = await caller.projectSources({ projectId });
  expect(sources.github).toMatchObject({ connectionId, repository: { id: 'repo-1' } });
  expect(sources).not.toHaveProperty('executionAvailable');
  await caller.get(owner);
  await caller.list({ projectId });
  await caller.runs(owner);
  await caller.evaluations(owner);
  await caller.navigationSummary({ projectId });
  expect(native).not.toHaveBeenCalled();
  expect(await caller.validateDraft({ projectId, specification: specification() })).toMatchObject({
    triggers: [{ capability: { status: 'SUPPORTED' } }],
    execution: {
      status: 'VALIDATED',
      intent: { reasoningEffort: 'high', requestedModel: 'sonnet', model: 'claude-sonnet-4-6' },
    },
  });
  expect(native).toHaveBeenCalledTimes(1);
});
it('rejects project source changes during external validation before any saved write', async () => {
  const owner = await save();
  const original = await caller.get(owner);
  repository.mockImplementationOnce(async () => {
    await db.prisma.project.update({ where: { id: projectId }, data: { githubRepo: 'different' } });
    return { id: 'repo-1', name: 'org/repo', labels: ['agent'] };
  });
  await expect(
    caller.updateSaved({
      ...owner,
      expectedManagementRevision: 1,
      specification: { ...original.specification!, name: 'Must not commit' },
    })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect((await caller.get(owner)).name).toBe('Investigator');
  expect((await caller.get(owner)).managementRevision).toBe(1);
});
it('keeps unsupported settings saveable while rejecting foreign and archived ownership', async () => {
  const owner = await save();
  const original = await caller.get(owner);
  const unsupported = {
    ...original.specification!,
    triggers: original.specification!.triggers.map((trigger) => ({
      ...trigger,
      filterInstructions: 'Semantic intent',
    })),
  };
  expect(
    await caller.updateSaved({
      ...owner,
      expectedManagementRevision: 1,
      specification: unsupported,
    })
  ).toMatchObject({ managementRevision: 2 });
  expect(
    (await caller.validateDraft({ projectId, specification: unsupported })).triggers[0]?.capability
      .reasonCode
  ).toBe('UNSUPPORTED_SEMANTIC_FILTER');
  await expect(caller.get({ ...owner, projectId: 'foreign' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  await db.prisma.project.update({ where: { id: projectId }, data: { isArchived: true } });
  expect(await caller.get(owner)).toMatchObject({ managementRevision: 2 });
  await expect(caller.projectSources({ projectId })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
  await expect(
    caller.validateDraft({ projectId, specification: specification() })
  ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
});
it.each([{ origin: 'https://evil.invalid' }, { 'x-forwarded-for': '203.0.113.1' }])(
  'reaches the real HTTP guard before management effects: %j',
  async (headers) => {
    const app = express();
    app.use(
      '/api/trpc',
      createExpressMiddleware({
        router: agentRouter,
        createContext: createContext({
          services: { ...services, agentManagement: createAgentManagement(() => services) },
        } as never),
      })
    );
    const response = await request(app)
      .get('/api/trpc/projectSources')
      .query({ input: JSON.stringify({ json: { projectId } }) })
      .set(headers);
    expect(response.status).toBe(403);
    expect(repository).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  }
);

it('does not certify a source disabled while native validation is pending', async () => {
  native.mockImplementationOnce(async () => {
    await db.prisma.agentConnection.update({
      where: { id: connectionId },
      data: { isEnabled: false },
    });
    return {
      provider: 'CLAUDE',
      model: 'claude-sonnet-4-6',
      reasoning: { options: [] },
      planMode: { supported: false, selected: false },
    };
  });
  const preview = await caller.validateDraft({ projectId, specification: specification() });
  expect(preview.triggers[0]?.capability).toMatchObject({
    status: 'UNAVAILABLE',
    reasonCode: 'SOURCE_UNAVAILABLE',
  });
});

it('reads retained workspace origins through the public owner before linkage and after deletion', async () => {
  const owner = await save();
  const creation = new workspace.WorkspaceCreationService({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });
  const runId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const run = await db.prisma.agentRun.create({
    data: {
      id: runId,
      agentDefinitionId: owner.agentId,
      idempotencyKey: runId,
      status: 'COMPLETED',
      launchPhase: 'FINISHED',
      reservedWorkspaceId: workspaceId,
      reservedSessionId: sessionId,
      definitionSnapshot: {},
      input: {},
      result: { version: 1, summary: 'Retained', pullRequests: [] },
    },
  });
  await creation.createEventWorkspaceOnce({
    type: 'EVENT_AGENT',
    projectId,
    runId,
    reservedWorkspaceId: workspaceId,
    reservedSessionId: sessionId,
    initialMessageId: crypto.randomUUID(),
    name: 'Event',
    execution: {
      version: 1,
      provider: 'CLAUDE',
      model: 'sonnet',
      reasoningEffort: null,
      codexAccountId: null,
      startupModePreset: 'non_interactive',
      accessMode: 'bypassPermissions',
      planModeEnabled: false,
    },
    input: { version: 1, context: [] },
  });
  expect(run.workspaceId).toBeNull();
  expect(await caller.workspaceOrigin({ projectId, workspaceId })).toMatchObject({
    origin: { runId, workspaceState: 'LIVE' },
    run: { id: runId },
  });
  const { captureWorkspaceRunResults } = await vi.importActual<
    typeof import('@/backend/orchestration/workspace-deletion.orchestrator')
  >('@/backend/orchestration/workspace-deletion.orchestrator');
  workspace.workspaceDataService.configureDeletionCapture(captureWorkspaceRunResults);
  await workspace.workspaceDataService.delete(workspaceId);
  expect(await caller.workspaceOrigin({ projectId, workspaceId })).toMatchObject({
    origin: { runId, workspaceState: 'DELETED' },
    run: { result: { summary: 'Retained' } },
  });
  expect((await caller.runs(owner)).items[0]?.workspaceState).toBe('DELETED');
  await expect(caller.workspaceOrigin({ projectId: 'foreign', workspaceId })).rejects.toMatchObject(
    { code: 'NOT_FOUND' }
  );
  await db.prisma.agentRun.update({
    where: { id: runId },
    data: { reservedWorkspaceId: 'mismatched' },
  });
  await expect(caller.workspaceOrigin({ projectId, workspaceId })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

it.each(['remote', 'origin', 'forwarded'] as const)(
  'rejects %s saved mutation at real HTTP middleware before source/write',
  async (mode) => {
    const owner = await save();
    const before = await caller.get(owner);
    const app = express();
    if (mode === 'remote') {
      app.use((req, _res, next) => {
        Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.1' });
        next();
      });
    }
    app.use(
      '/api/trpc',
      createExpressMiddleware({
        router: agentRouter,
        createContext: createContext({
          services: { ...services, agentManagement: createAgentManagement(() => services) },
        } as never),
      })
    );
    const response = await request(app)
      .post('/api/trpc/updateSaved')
      .send({
        json: {
          ...owner,
          expectedManagementRevision: 1,
          specification: { ...before.specification, name: 'Forbidden mutation' },
        },
      })
      .set(
        mode === 'origin'
          ? { Origin: 'https://evil.invalid' }
          : mode === 'forwarded'
            ? { 'x-forwarded-for': '203.0.113.1' }
            : {}
      );
    expect(response.status).toBe(403);
    expect(repository).not.toHaveBeenCalled();
    expect((await caller.get(owner)).managementRevision).toBe(1);
  }
);

it('rejects a live workspace whose retained origin disagrees with its creation identity', async () => {
  const row = await db.prisma.workspace.create({ data: { projectId, name: 'Ordinary' } });
  expect(await caller.workspaceOrigin({ projectId, workspaceId: row.id })).toBeNull();
  await db.prisma.workspaceLaunchOrigin.create({
    data: { projectId, workspaceId: row.id, runId: 'unrelated-retained-run' },
  });
  await expect(caller.workspaceOrigin({ projectId, workspaceId: row.id })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

it('rejects a history run whose live workspace link disagrees with its reservation', async () => {
  const owner = await save();
  const unrelated = await db.prisma.workspace.create({ data: { projectId, name: 'Unrelated' } });
  await db.prisma.agentRun.create({
    data: {
      agentDefinitionId: owner.agentId,
      idempotencyKey: crypto.randomUUID(),
      reservedWorkspaceId: 'different-reservation',
      workspaceId: unrelated.id,
      definitionSnapshot: {},
      input: {},
    },
  });
  await expect(caller.runs(owner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
