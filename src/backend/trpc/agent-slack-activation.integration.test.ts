import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let createAgentManagement: typeof import('@/backend/orchestration/agents/agent-management.orchestrator').createAgentManagement;
let agentRouter: typeof import('./agent.trpc').agentRouter;
let runtime: typeof import('@/backend/services/agent-definition');
let workspace: typeof import('@/backend/services/workspace');
let configService: typeof import('@/backend/services/config.service').configService;

let db: IntegrationDatabase;
let projectId: string;
let connectionId: string;
let intakeEnabled: boolean;
let services: ReturnType<typeof makeServices>;
let caller: ReturnType<typeof agentRouter.createCaller>;

/** Slack's conversations.info for this fixture: the bot is in #support only. */
function slackRequest(url: string | URL | Request) {
  const channel = new URL(String(url)).searchParams.get('channel');
  return Promise.resolve(
    Response.json({
      ok: true,
      channel: { id: channel, name: 'support', is_member: channel === 'C1', is_archived: false },
    })
  );
}
function makeServices() {
  return {
    agentRuntime: {
      recovery: undefined,
      activation: new runtime.AgentActivationService({
        prepareBaseline: () => Promise.reject(new Error('No GitHub source here')),
      }),
    },
    agentManagementService: new runtime.AgentManagementService(),
    agentProposalService: new runtime.AgentProposalService(),
    projectManagementService: workspace.projectManagementService,
    workspaceDataService: workspace.workspaceDataService,
    slackConnectionService: new runtime.SlackConnectionService(
      { encrypt: (value) => value, decrypt: (value) => value },
      slackRequest as typeof fetch
    ),
    githubCLIService: {
      getAgentRepository: () => Promise.reject(new Error('Unexpected GitHub call')),
    },
    sessionProviderResolverService: {
      resolveDefaultsForWorkspaceCreation: async () => ({
        provider: 'CLAUDE' as const,
        model: 'sonnet',
      }),
    },
    userSettingsQueryService: {
      get: async () => ({ defaultClaudeReasoningEffort: null, defaultCodexReasoningEffort: null }),
    },
    sessionConfigService: {
      getLaunchOptions: async () => ({
        provider: 'CLAUDE' as const,
        model: 'claude-sonnet-4-6',
        reasoning: { options: [{ value: 'high', label: 'High' }], defaultValue: 'high' },
        planMode: { supported: true, selected: false },
      }),
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
  ({ configService } = await vi.importActual<typeof import('@/backend/services/config.service')>(
    '@/backend/services/config.service'
  ));
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
  projectId = (
    await db.prisma.project.create({
      data: { name: 'Factory', slug: crypto.randomUUID(), repoPath: '/r', worktreeBasePath: '/w' },
    })
  ).id;
  connectionId = (
    await db.prisma.agentConnection.create({
      data: {
        provider: 'SLACK',
        externalId: 'T1',
        name: 'Company',
        credentialsEncrypted: 'xoxb-bot',
        appCredentialsEncrypted: 'xapp-app',
        appId: 'A1',
      },
    })
  ).id;
  intakeEnabled = true;
  const limits = configService.getAgentRuntimeLimits();
  vi.spyOn(configService, 'getAgentRuntimeLimits').mockImplementation(() => ({
    ...limits,
    slackIntakeEnabled: intakeEnabled,
  }));
  services = makeServices();
  caller = agentRouter.createCaller({
    appContext: {
      services: { ...services, agentManagement: createAgentManagement(() => services) },
    },
  } as never);
});

async function save(config: Record<string, unknown> = { channelIds: ['C1'] }) {
  const row = await db.prisma.workspace.create({ data: { projectId, name: 'Author' } });
  const specification = {
    name: 'Responder',
    instructions: 'Answer support questions',
    executionConfig: { version: 1 as const },
    triggers: [
      {
        type: 'SLACK_MESSAGE' as const,
        connectionId,
        description: 'Support messages',
        filterInstructions: null,
        isEnabled: false as const,
        config: { version: 1 as const, ...config },
      },
    ],
  };
  const draft = await services.agentProposalService.propose({
    workspaceId: row.id,
    specification,
  });
  const accepted = await services.agentProposalService.create({
    workspaceId: row.id,
    proposalId: draft.id,
    revision: 1,
    specification: draft.specification,
  });
  return { projectId, agentId: accepted.agentDefinitionId! };
}
async function storedTrigger(agentId: string) {
  return await db.prisma.agentTrigger.findFirstOrThrow({ where: { agentDefinitionId: agentId } });
}
async function expectRefused(
  owner: { projectId: string; agentId: string },
  reasonCode: string,
  explanation: string,
  /** A read cannot recheck channel access, so it reports only what it can know. */
  readReasonCode = reasonCode
) {
  const preview = await caller.validateDraft({
    projectId,
    specification: (await caller.get(owner)).specification!,
  });
  expect(preview.triggers[0]?.capability.reasonCode).toBe(reasonCode);
  await expect(caller.enable({ ...owner, expectedManagementRevision: 1 })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.stringContaining(explanation),
  });
  expect(await storedTrigger(owner.agentId)).toMatchObject({
    activationState: 'PAUSED',
    pendingActivation: null,
  });
  expect(await caller.get(owner)).toMatchObject({
    isEnabled: false,
    managementRevision: 1,
    configuredTriggers: [{ capability: { reasonCode: readReasonCode }, pendingVerification: null }],
  });
}

it('keeps Slack triggers unavailable and creates no pending activation while intake is off', async () => {
  intakeEnabled = false;
  const owner = await save();
  await expectRefused(owner, 'SLACK_INTAKE_UNAVAILABLE', 'Slack event intake is not available');
});

it('asks for the app-level token before a Slack trigger can start', async () => {
  await db.prisma.agentConnection.update({
    where: { id: connectionId },
    data: { appCredentialsEncrypted: null, appId: null },
  });
  const owner = await save();
  await expectRefused(owner, 'SLACK_APP_TOKEN_REQUIRED', 'app-level token');
});

it('refuses a channel the bot can no longer read', async () => {
  const owner = await save({ channelIds: ['C9'] });
  await expectRefused(owner, 'SOURCE_UNAVAILABLE', 'could not be verified', 'SUPPORTED');
});

it('starts a supported Slack trigger and shows the test message for its channel', async () => {
  const owner = await save();
  const enabled = await caller.enable({ ...owner, expectedManagementRevision: 1 });
  expect(enabled).toMatchObject({
    isEnabled: true,
    managementRevision: 2,
    configuredTriggers: [
      {
        activationState: 'STARTING',
        isEnabled: false,
        capability: { status: 'SUPPORTED' },
        pendingVerification: {
          message: expect.stringMatching(
            /^Factory Factory check [a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/
          ),
          channels: [{ channelId: 'C1', name: '#support', verified: false }],
        },
      },
    ],
  });
  expect((await storedTrigger(owner.agentId)).pendingActivation).toMatchObject({
    provider: 'SLACK',
    workspaceId: 'T1',
    appId: 'A1',
    channels: [{ channelId: 'C1', name: '#support', eventTs: null }],
  });
});
