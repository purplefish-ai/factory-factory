import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createAgentAuthoring } from '@/backend/orchestration/agent-authoring.orchestrator';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { agentRouter } from './agent.trpc';

let db: IntegrationDatabase;
let caller: ReturnType<typeof agentRouter.createCaller>;
let workspaceId: string;
let slackId: string;
const repository = { id: '123', name: 'purplefish-ai/factory-factory', labels: ['bug', 'agent'] };
const channels = new Map([
  ['C-feedback', 'customer-feedback'],
  ['C-data', 'data-quality'],
  ['C-bugs', 'bug-reports'],
  ['C-review', 'fillet-packet-review'],
]);
beforeAll(async () => {
  db = await createIntegrationDatabase();
  const { AgentProposalService, SlackConnectionService } = await vi.importActual<
    typeof import('@/backend/services/agent-definition')
  >('@/backend/services/agent-definition');
  const project = await db.prisma.project.create({
    data: {
      name: 'Factory',
      slug: 'factory',
      repoPath: '/repo',
      worktreeBasePath: '/worktrees',
      githubOwner: 'purplefish-ai',
      githubRepo: 'factory-factory',
    },
  });
  const workspace = await db.prisma.workspace.create({
    data: { projectId: project.id, name: 'Authoring' },
  });
  workspaceId = workspace.id;
  const connection = await db.prisma.agentConnection.create({
    data: {
      provider: 'SLACK',
      externalId: 'T-company',
      name: 'Company',
      credentialsEncrypted: 'ciphertext',
    },
  });
  slackId = connection.id;
  const slack = new SlackConnectionService(
    { encrypt: (value) => value, decrypt: () => 'test-token' },
    (url) => {
      const request = new URL(String(url));
      const id = request.searchParams.get('channel');
      const values = [...channels].map(([channelId, name]) => ({
        id: channelId,
        name,
        is_member: true,
        is_archived: false,
      }));
      const channel = values.find((value) => value.id === id);
      return Promise.resolve(
        new Response(
          JSON.stringify(id ? { ok: Boolean(channel), channel } : { ok: true, channels: values })
        )
      );
    }
  );
  const services = {
    workspaceDataService: {
      findByIdWithProject: (id: string) =>
        db.prisma.workspace.findUnique({ where: { id }, include: { project: true } }),
    },
    slackConnectionService: slack,
    agentProposalService: new AgentProposalService(),
    githubCLIService: { getAgentRepository: async () => repository },
  };
  caller = agentRouter.createCaller({
    appContext: {
      services: { ...services, agentAuthoring: createAgentAuthoring(() => services as never) },
    },
  } as never);
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

it('discovers safe, project-scoped Slack and GitHub resources', async () => {
  const sources = await caller.sources({ workspaceId, connectionId: slackId });
  expect(sources.slack.channels).toContainEqual({ id: 'C-feedback', name: 'customer-feedback' });
  expect(sources.github).toMatchObject({ repository });
  expect(JSON.stringify(sources)).not.toMatch(/ciphertext|test-token/);
});

it('creates the three configured scenarios using discovered resource IDs', async () => {
  const sources = await caller.sources({ workspaceId });
  if (!('connectionId' in sources.github)) {
    throw new Error('Missing GitHub source');
  }
  const scenarios = [
    {
      name: 'Feedback',
      instructions: 'Investigate bugs in the development database.',
      triggers: [
        {
          type: 'SLACK_MESSAGE' as const,
          connectionId: slackId,
          description: 'Feedback channels',
          filterInstructions: 'Include human and automated reports. Investigate uncertain cases.',
          config: { version: 1 as const, channelIds: ['C-feedback', 'C-data', 'C-bugs'] },
        },
      ],
    },
    {
      name: 'QA review',
      instructions: 'Compare QA edits after packet unlock.',
      triggers: [
        {
          type: 'SLACK_MESSAGE' as const,
          connectionId: slackId,
          description: 'Packet unlock in review threads',
          filterInstructions: 'The packet was unlocked, meaning QA is complete.',
          config: { version: 1 as const, channelIds: ['C-review'] },
        },
      ],
    },
    {
      name: 'Issue executor',
      instructions: 'Execute the issue and open a PR.',
      triggers: [
        {
          type: 'GITHUB_ISSUE' as const,
          connectionId: sources.github.connectionId,
          description: 'Issues with the agent label',
          config: {
            version: 1 as const,
            repositoryIds: ['123'],
            actions: ['opened' as const, 'labeled' as const],
            labels: ['agent'],
          },
        },
      ],
    },
  ];
  for (const specification of scenarios) {
    const proposal = await caller.propose({ workspaceId, specification } as never);
    const saved = await caller.create({
      workspaceId,
      proposalId: proposal.id,
      revision: proposal.revision,
      specification: proposal.specification,
    });
    const agent = await db.prisma.agentDefinition.findUniqueOrThrow({
      where: { id: saved.agentDefinitionId ?? '' },
      include: { triggers: true },
    });
    expect(agent.name).toBe(specification.name);
    expect(agent.triggers).toHaveLength(1);
    expect(agent.triggers[0]?.config).toMatchObject(specification.triggers[0]!.config);
  }
});

it('rejects invented channels, foreign repositories, and unknown labels without saving drafts', async () => {
  const sources = await caller.sources({ workspaceId });
  if (!('connectionId' in sources.github)) {
    throw new Error('Missing GitHub source');
  }
  const count = await db.prisma.agentProposal.count();
  const base = { name: 'Invalid', instructions: 'Investigate' };
  for (const trigger of [
    {
      type: 'SLACK_MESSAGE',
      connectionId: slackId,
      description: 'Invented sender',
      config: { version: 1, channelIds: ['C-feedback'], senderIds: ['U-invented'] },
    },
    {
      type: 'GITHUB_ISSUE',
      connectionId: sources.github.connectionId,
      description: 'Invented creator',
      config: { version: 1, repositoryIds: ['123'], actions: ['opened'], creatorIds: ['invented'] },
    },
    {
      type: 'SLACK_MESSAGE',
      connectionId: slackId,
      description: 'Unavailable',
      config: { version: 1, channelIds: ['C-invented'] },
    },
    {
      type: 'GITHUB_ISSUE',
      connectionId: sources.github.connectionId,
      description: 'Other repo',
      config: { version: 1, repositoryIds: ['999'], actions: ['opened'] },
    },
    {
      type: 'GITHUB_ISSUE',
      connectionId: sources.github.connectionId,
      description: 'Unknown label',
      config: { version: 1, repositoryIds: ['123'], actions: ['opened'], labels: ['invented'] },
    },
  ]) {
    await expect(
      caller.propose({ workspaceId, specification: { ...base, triggers: [trigger] } } as never)
    ).rejects.toThrow();
  }
  expect(await db.prisma.agentProposal.count()).toBe(count);
});

it('blocks remote authoring requests', async () => {
  const remote = agentRouter.createCaller({
    requestTrust: { isLocal: false, remoteAddress: '203.0.113.1' },
    appContext: { services: { configService: { getCorsConfig: () => ({}) } } },
  } as never);
  await expect(remote.sources({ workspaceId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(remote.getProposal({ workspaceId, proposalId: 'unknown' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
});
