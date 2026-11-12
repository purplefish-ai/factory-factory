import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { AgentGitHubSourcePort, AgentIssueEventPage } from '@/shared/agent-source';
let createAgentManagement: typeof import('@/backend/orchestration/agents/agent-management.orchestrator').createAgentManagement;
let createContext: typeof import('./trpc').createContext;
let agentRouter: typeof import('./agent.trpc').agentRouter;

let db: IntegrationDatabase;
let runtime: typeof import('@/backend/services/agent-definition');
let workspace: typeof import('@/backend/services/workspace');
let projectId: string;
let connectionId: string;
let feed: AgentIssueEventPage['events'];
let onList: (() => Promise<void>) | null;
let services: ReturnType<typeof makeServices>;
let caller: ReturnType<typeof agentRouter.createCaller>;

const port: AgentGitHubSourcePort = {
  getRepositoryIdentity: async () => ({ id: 'repo-1', name: 'org/repo' }),
  listIssueEvents: async (input) => {
    const hook = onList;
    onList = null;
    await hook?.();
    return {
      events: feed.slice((input.page - 1) * 100, input.page * 100),
      nextPage: input.page * 100 < feed.length ? input.page + 1 : null,
    };
  },
  classifyError: () => 'unknown',
};
const execution = {
  version: 1 as const,
  provider: 'CLAUDE' as const,
  model: 'sonnet',
  reasoningEffort: null,
  codexAccountId: null,
  startupModePreset: 'non_interactive' as const,
  accessMode: 'bypassPermissions',
  planModeEnabled: false as const,
};
function makeServices() {
  const poller = new runtime.AgentSourcePollService(port, () => 10);
  return {
    poller,
    agentRuntime: { recovery: undefined, activation: new runtime.AgentActivationService(poller) },
    agentManagementService: new runtime.AgentManagementService(),
    agentProposalService: new runtime.AgentProposalService(),
    projectManagementService: workspace.projectManagementService,
    workspaceDataService: workspace.workspaceDataService,
    slackConnectionService: new runtime.SlackConnectionService(
      { encrypt: (value) => value, decrypt: (value) => value },
      () => Promise.reject(new Error('Unexpected Slack call'))
    ),
    githubCLIService: {
      getAgentRepository: async () => ({ id: 'repo-1', name: 'org/repo', labels: ['agent'] }),
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
      getLaunchOptions: async () => ({
        provider: 'CLAUDE' as const,
        model: 'claude-sonnet-4-6',
        reasoning: { options: [] },
        planMode: { supported: true, selected: false },
      }),
    },
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
const appServices = () => ({
  ...services,
  agentManagement: createAgentManagement(() => services),
});
beforeAll(async () => {
  db = await createIntegrationDatabase();
  ({ agentRouter } = await vi.importActual<typeof import('./agent.trpc')>('./agent.trpc'));
  ({ createContext } = await vi.importActual<typeof import('./trpc')>('./trpc'));
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
  await db.prisma.agentEvent.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.workspaceLaunchOrigin.deleteMany();
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
          isReady: true,
          cursor: { version: 1, provider: 'GITHUB', committedHeadEventId: 'B', scan: null },
          health: { state: 'READY', reasonCode: null, updatedAt: new Date().toISOString() },
        },
      },
    },
  });
  connectionId = connection.id;
  feed = [
    { providerEventId: 'N', payload: null },
    { providerEventId: 'B', payload: null },
  ];
  onList = null;
  services = makeServices();
  caller = agentRouter.createCaller({ appContext: { services: appServices() } } as never);
});
async function save() {
  const author = await db.prisma.workspace.create({ data: { projectId, name: 'Author' } });
  const draft = await services.agentProposalService.propose({
    workspaceId: author.id,
    specification: {
      name: 'Investigator',
      instructions: 'Investigate',
      executionConfig: { version: 1 },
      triggers: [
        {
          type: 'GITHUB_ISSUE',
          connectionId,
          description: 'Agent label',
          filterInstructions: null,
          isEnabled: false,
          config: {
            version: 1,
            repositoryIds: ['repo-1'],
            actions: ['labeled'],
            labels: ['agent'],
          },
        },
      ],
    },
  });
  const accepted = await services.agentProposalService.create({
    workspaceId: author.id,
    proposalId: draft.id,
    revision: 1,
    specification: draft.specification,
  });
  return {
    owner: { projectId, agentId: accepted.agentDefinitionId! },
    proposal: { workspaceId: author.id, proposalId: draft.id },
  };
}
async function cycle() {
  const signal = new AbortController().signal;
  await services.poller.pollCycle(signal);
  await services.agentRuntime.activation.completePending(signal);
}
/** A run, and the event workspace it created through the workspace owner. */
async function eventWorkspace(
  agentId: string,
  run: { status: 'COMPLETED' | 'RUNNING'; launchPhase: 'FINISHED' | 'ACTIVE' }
) {
  const runId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await db.prisma.agentRun.create({
    data: {
      id: runId,
      agentDefinitionId: agentId,
      idempotencyKey: runId,
      ...run,
      reservedWorkspaceId: workspaceId,
      reservedSessionId: sessionId,
      definitionSnapshot: {},
      input: {},
      result: { version: 1, summary: 'Opened a fix', pullRequests: [] },
    },
  });
  const creation = new workspace.WorkspaceCreationService({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });
  await creation.createEventWorkspaceOnce({
    type: 'EVENT_AGENT',
    projectId,
    runId,
    reservedWorkspaceId: workspaceId,
    reservedSessionId: sessionId,
    initialMessageId: crypto.randomUUID(),
    name: 'Event',
    execution,
    input: { version: 1, context: [] },
  });
  await db.prisma.agentRun.update({ where: { id: runId }, data: { workspaceId } });
  return { runId, workspaceId };
}

it('deletes the automation, its history and accepted proposal; its workspace keeps a retained origin', async () => {
  const { owner, proposal } = await save();
  const enabled = await caller.enable({ ...owner, expectedManagementRevision: 1 });
  await cycle();
  expect((await caller.get(owner)).configuredTriggers[0]?.activationState).toBe('ACTIVE');
  const started = await eventWorkspace(owner.agentId, {
    status: 'COMPLETED',
    launchPhase: 'FINISHED',
  });
  expect(
    await caller.workspaceOrigin({ projectId, workspaceId: started.workspaceId })
  ).toMatchObject({
    origin: { runId: started.runId, workspaceState: 'LIVE' },
    run: { id: started.runId },
  });
  expect(await caller.navigationSummary({ projectId })).toEqual({ totalCount: 1, failedCount: 0 });

  expect(
    await caller.delete({
      ...owner,
      expectedManagementRevision: enabled.managementRevision,
    })
  ).toEqual({ deleted: true });

  await expect(caller.get(owner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(caller.runs(owner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await caller.list({ projectId })).items).toEqual([]);
  expect(await caller.navigationSummary({ projectId })).toEqual({ totalCount: 0, failedCount: 0 });
  await expect(caller.getProposal(proposal)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  // The authoring and event workspaces stay. The origin is provenance without a run,
  // which removes the workspace's Runs tab as deleting a scheduled automation does.
  expect(await db.prisma.workspace.count()).toBe(2);
  expect(await caller.workspaceOrigin({ projectId, workspaceId: started.workspaceId })).toEqual({
    origin: {
      projectId,
      workspaceId: started.workspaceId,
      runId: started.runId,
      workspaceState: 'LIVE',
    },
    run: null,
  });
  // Deleting the workspace afterwards still works without its run.
  const { captureWorkspaceRunResults } = await vi.importActual<
    typeof import('@/backend/orchestration/workspace-lifecycle/workspace-deletion.orchestrator')
  >('@/backend/orchestration/workspace-lifecycle/workspace-deletion.orchestrator');
  workspace.workspaceDataService.configureDeletionCapture(captureWorkspaceRunResults);
  await workspace.workspaceDataService.delete(started.workspaceId);
  expect(await caller.workspaceOrigin({ projectId, workspaceId: started.workspaceId })).toEqual({
    origin: expect.objectContaining({ workspaceState: 'DELETED' }),
    run: null,
  });
  expect(await db.prisma.agentConnection.count()).toBe(1);
});

it('refuses while a started run is unfinished, telling the user what to do, and stays enabled', async () => {
  const { owner } = await save();
  const enabled = await caller.enable({ ...owner, expectedManagementRevision: 1 });
  await cycle();
  await eventWorkspace(owner.agentId, { status: 'RUNNING', launchPhase: 'ACTIVE' });
  const input = { ...owner, expectedManagementRevision: enabled.managementRevision };
  const before = await caller.get(owner);

  await expect(caller.delete(input)).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message:
      '1 run of this automation has started and not finished. Let it finish, or stop it in the ' +
      'workspace (or abandon it from the Runs view if it needs attention), then delete the ' +
      'automation again. Nothing was changed.',
  });

  expect(await caller.get(owner)).toEqual(before);
  expect(before.configuredTriggers[0]?.activationState).toBe('ACTIVE');
  expect((await caller.runs(owner)).items).toHaveLength(1);
});

it('refuses stale revisions and foreign owners', async () => {
  const { owner } = await save();
  await expect(caller.delete({ ...owner, expectedManagementRevision: 2 })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  await expect(
    caller.delete({ ...owner, projectId: 'foreign', expectedManagementRevision: 1 })
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await caller.get(owner)).toMatchObject({ managementRevision: 1 });
});

it('finishes an Enable whose automation is deleted while the baseline is prepared', async () => {
  const { owner } = await save();
  onList = async () => {
    await caller.delete({ ...owner, expectedManagementRevision: 2 });
  };
  feed = [{ providerEventId: 'B', payload: null }];
  // Enable's own re-read reports the automation as gone; nothing is left STARTING.
  await expect(caller.enable({ ...owner, expectedManagementRevision: 1 })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  expect(onList).toBeNull();
  await cycle();
  expect(await db.prisma.agentTrigger.count()).toBe(0);
  expect(await db.prisma.agentDefinition.count()).toBe(0);
});

it('reaches the real HTTP guard before deleting', async () => {
  const { owner } = await save();
  const app = express();
  app.use(
    '/api/trpc',
    createExpressMiddleware({
      router: agentRouter,
      createContext: createContext({ services: appServices() } as never),
    })
  );
  const response = await request(app)
    .post('/api/trpc/delete')
    .set({ origin: 'https://evil.invalid' })
    .send({ json: { ...owner, expectedManagementRevision: 1 } });
  expect(response.status).toBe(403);
  expect(await db.prisma.agentDefinition.count()).toBe(1);
});
