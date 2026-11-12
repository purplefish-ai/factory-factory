import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { AgentGitHubSourcePort, AgentIssueEventPage } from '@/shared/agent-source';
let createAgentManagement: typeof import('@/backend/orchestration/agents/agent-management.orchestrator').createAgentManagement;
let agentRouter: typeof import('./agent.trpc').agentRouter;

let db: IntegrationDatabase;
let runtime: typeof import('@/backend/services/agent-definition');
let workspace: typeof import('@/backend/services/workspace');
let projectId: string;
let connectionId: string;
let feed: AgentIssueEventPage['events'];
let onList: (() => Promise<void>) | null;
let native: ReturnType<
  typeof vi.fn<() => Promise<import('@/shared/session-launch').SessionLaunchOptions>>
>;
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
      get: async () => ({ defaultClaudeReasoningEffort: 'max', defaultCodexReasoningEffort: null }),
    },
    sessionConfigService: { getLaunchOptions: async () => native() },
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
  await db.prisma.agentEvent.deleteMany();
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
  // An already-polled source: the next baseline resolves only after a poll cycle.
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
function trigger(actions: Array<'labeled' | 'opened'>) {
  return {
    type: 'GITHUB_ISSUE' as const,
    connectionId,
    description: actions.join(' '),
    filterInstructions: null,
    isEnabled: false as const,
    config: { version: 1 as const, repositoryIds: ['repo-1'], actions, labels: ['agent'] },
  };
}
async function save(triggers = [trigger(['labeled']), trigger(['opened'])]) {
  const row = await db.prisma.workspace.create({ data: { projectId, name: 'Author' } });
  const draft = await services.agentProposalService.propose({
    workspaceId: row.id,
    specification: {
      name: 'Investigator',
      instructions: 'Investigate',
      executionConfig: { version: 1 },
      triggers,
    },
  });
  const accepted = await services.agentProposalService.create({
    workspaceId: row.id,
    proposalId: draft.id,
    revision: 1,
    specification: draft.specification,
  });
  return { projectId, agentId: accepted.agentDefinitionId! };
}
async function cycle() {
  const signal = new AbortController().signal;
  await services.poller.pollCycle(signal);
  await services.agentRuntime.activation.completePending(signal);
}
const states = (agent: { configuredTriggers: { activationState: string }[] }) =>
  agent.configuredTriggers.map((row) => row.activationState);

it('starts the supported trigger, keeps the unsupported one paused, then activates on the baseline', async () => {
  const owner = await save();
  const enabled = await caller.enable({ ...owner, expectedManagementRevision: 1 });
  expect(enabled).toMatchObject({ isEnabled: true, managementRevision: 2 });
  const [labeled, opened] = [...enabled.configuredTriggers].sort((a, b) =>
    (a.configuration?.description ?? '').localeCompare(b.configuration?.description ?? '')
  );
  expect(labeled).toMatchObject({ activationState: 'STARTING', pausedReasonCode: null });
  expect(opened).toMatchObject({
    activationState: 'PAUSED',
    capability: { status: 'UNSUPPORTED', reasonCode: 'UNSUPPORTED_GITHUB_ACTION' },
  });
  // Validation applied native normalization: the inherited "max" effort is not offered.
  expect(
    (await db.prisma.agentDefinition.findUniqueOrThrow({ where: { id: owner.agentId } }))
      .validatedIntent
  ).toMatchObject({
    definitionRevision: 1,
    execution: { reasoningEffort: 'high', effortNormalization: 'INHERITED_TO_NATIVE_DEFAULT' },
  });

  await cycle();
  const active = await caller.get(owner);
  expect(active.configuredTriggers.find((row) => row.id === labeled?.id)).toMatchObject({
    activationState: 'ACTIVE',
    isEnabled: true,
  });
  expect(
    await db.prisma.agentTrigger.findUniqueOrThrow({ where: { id: labeled?.id } })
  ).toMatchObject({ activationBoundary: { provider: 'GITHUB', headEventId: 'N' } });
  expect(active.configuredTriggers.find((row) => row.id === opened?.id)?.activationState).toBe(
    'PAUSED'
  );
});

it('fails with the reasons and changes nothing when no trigger can start', async () => {
  const owner = await save([trigger(['opened'])]);
  await expect(caller.enable({ ...owner, expectedManagementRevision: 1 })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.stringContaining('Only GitHub labeled and reopened events are supported.'),
  });
  expect(await caller.get(owner)).toMatchObject({ isEnabled: false, managementRevision: 1 });
  expect(
    (await db.prisma.agentDefinition.findUniqueOrThrow({ where: { id: owner.agentId } }))
      .validatedIntent
  ).toBeNull();
});

it('fails when native execution cannot be validated', async () => {
  const owner = await save();
  native.mockRejectedValueOnce(new Error('discovery failed'));
  await expect(caller.enable({ ...owner, expectedManagementRevision: 1 })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
  expect(states(await caller.get(owner))).toEqual(['PAUSED', 'PAUSED']);
});

it('refuses stale revisions and foreign owners', async () => {
  const owner = await save();
  await expect(caller.enable({ ...owner, expectedManagementRevision: 2 })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  await expect(
    caller.enable({ ...owner, projectId: 'foreign', expectedManagementRevision: 1 })
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(caller.pause({ ...owner, expectedManagementRevision: 2 })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  expect(states(await caller.get(owner))).toEqual(['PAUSED', 'PAUSED']);
});

it('ends PAUSED, never ACTIVE, when instructions are edited while a trigger is STARTING', async () => {
  const owner = await save([trigger(['labeled'])]);
  const enabled = await caller.enable({ ...owner, expectedManagementRevision: 1 });
  expect(states(enabled)).toEqual(['STARTING']);
  const edited = await caller.updateSaved({
    ...owner,
    expectedManagementRevision: 2,
    specification: { ...enabled.specification!, instructions: 'Investigate differently' },
  });
  expect(edited).toMatchObject({ definitionRevision: 2 });
  await cycle();
  await cycle();
  const row = await db.prisma.agentTrigger.findFirstOrThrow({
    where: { agentDefinitionId: owner.agentId },
  });
  expect(row).toMatchObject({
    activationState: 'PAUSED',
    activationBoundary: null,
    pendingActivation: null,
  });
});

it('ends PAUSED when instructions are edited while Enable is preparing the baseline', async () => {
  const owner = await save([trigger(['labeled'])]);
  const saved = await caller.get(owner);
  onList = async () => {
    await caller.updateSaved({
      ...owner,
      expectedManagementRevision: 2,
      specification: { ...saved.specification!, instructions: 'Investigate differently' },
    });
  };
  // The new definition revision invalidates the validated intent and the pending generation.
  feed = [{ providerEventId: 'B', payload: null }];
  await caller.enable({ ...owner, expectedManagementRevision: 1 });
  await cycle();
  const row = await db.prisma.agentTrigger.findFirstOrThrow({
    where: { agentDefinitionId: owner.agentId },
  });
  expect(row).toMatchObject({
    activationState: 'PAUSED',
    activationBoundary: null,
    // Paused by the edit, not by a failed preparation.
    pausedReasonCode: null,
  });
  expect(onList).toBeNull();
  expect(await caller.get(owner)).toMatchObject({
    definitionRevision: 2,
    instructions: 'Investigate differently',
  });
});

it('pauses through the trusted-local procedure', async () => {
  const owner = await save([trigger(['labeled'])]);
  await caller.enable({ ...owner, expectedManagementRevision: 1 });
  await cycle();
  expect(states(await caller.get(owner))).toEqual(['ACTIVE']);
  const paused = await caller.pause({ ...owner, expectedManagementRevision: 2 });
  expect(paused).toMatchObject({ isEnabled: false, managementRevision: 3 });
  expect(states(paused)).toEqual(['PAUSED']);
  expect(paused.configuredTriggers[0]?.activationGeneration).toBe(2);
});
