import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let service: import('./agent-proposal.service').AgentProposalService;
let workspaceId: string;
let projectId: string;
let connectionId: string;
const specification = () => ({
  name: 'Feedback investigator',
  instructions: 'Investigate bugs using a development database.',
  triggers: [
    {
      type: 'SLACK_MESSAGE',
      connectionId,
      description: 'Bug reports in feedback channels',
      filterInstructions: 'Include automated and human reports. Investigate uncertain cases.',
      config: {
        version: 1,
        channelIds: ['C-feedback'],
        context: { includeThread: true, nearbyMessageCount: 0 },
      },
    },
  ],
});

beforeAll(async () => {
  db = await createIntegrationDatabase();
  const { AgentProposalService } = await vi.importActual<typeof import('./agent-proposal.service')>(
    './agent-proposal.service'
  );
  service = new AgentProposalService();
  const project = await db.prisma.project.create({
    data: {
      name: 'Factory',
      slug: 'factory',
      repoPath: '/repo',
      worktreeBasePath: '/worktrees',
    },
  });
  projectId = project.id;
  const workspace = await db.prisma.workspace.create({ data: { projectId, name: 'Authoring' } });
  workspaceId = workspace.id;
  const connection = await db.prisma.agentConnection.create({
    data: {
      provider: 'SLACK',
      externalId: 'T-company',
      name: 'Company',
      credentialsEncrypted: 'encrypted',
    },
  });
  connectionId = connection.id;
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

it('persists a proposal without creating an agent and scopes reads to its workspace', async () => {
  const proposal = await service.propose({ workspaceId, specification: specification() });
  expect(proposal).toMatchObject({ revision: 1, agentDefinitionId: null });
  expect(await db.prisma.agentDefinition.count()).toBe(0);
  expect(
    (await service.get(workspaceId, proposal.id)).specification.triggers[0]?.filterInstructions
  ).toContain('human');
  await expect(service.get('other-workspace', proposal.id)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

it('revises a proposal and refuses stale conversational edits', async () => {
  const original = await service.propose({ workspaceId, specification: specification() });
  const next = await service.propose({
    workspaceId,
    proposalId: original.id,
    revision: 1,
    specification: { ...specification(), name: 'Human and automated reports' },
  });
  expect(next.revision).toBe(2);
  await expect(
    service.propose({
      workspaceId,
      proposalId: original.id,
      revision: 1,
      specification: specification(),
    })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect((await service.get(workspaceId, original.id)).specification.name).toBe(
    'Human and automated reports'
  );
});

it('creates the exact user-edited definition and triggers once across repeated acceptance', async () => {
  const proposal = await service.propose({ workspaceId, specification: specification() });
  const edited = {
    ...proposal.specification,
    instructions: 'Compare QA edits in the development database.',
  };
  const results = await Promise.all([
    service.create({ workspaceId, proposalId: proposal.id, revision: 1, specification: edited }),
    service.create({ workspaceId, proposalId: proposal.id, revision: 1, specification: edited }),
  ]);
  expect(results[0].agentDefinitionId).toBe(results[1].agentDefinitionId);
  expect(await db.prisma.agentDefinition.count()).toBe(1);
  const saved = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: results[0].agentDefinitionId ?? '' },
    include: { triggers: true },
  });
  expect(saved).toMatchObject({ projectId, instructions: edited.instructions, isEnabled: false });
  expect(saved.triggers[0]).toMatchObject({
    connectionId,
    isEnabled: false,
    config: { channelIds: ['C-feedback'], context: { includeThread: true } },
  });
  await expect(
    service.propose({
      workspaceId,
      proposalId: proposal.id,
      revision: 1,
      specification: specification(),
    })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('rejects stale acceptance without creating anything', async () => {
  const proposal = await service.propose({ workspaceId, specification: specification() });
  await service.propose({
    workspaceId,
    proposalId: proposal.id,
    revision: 1,
    specification: proposal.specification,
  });
  const count = await db.prisma.agentDefinition.count();
  await expect(
    service.create({
      workspaceId,
      proposalId: proposal.id,
      revision: 1,
      specification: specification(),
    })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await db.prisma.agentDefinition.count()).toBe(count);
});

it('edits a created agent without replacing trigger identities or historical snapshots', async () => {
  const proposal = await service.propose({ workspaceId, specification: specification() });
  const created = await service.create({
    workspaceId,
    proposalId: proposal.id,
    revision: 1,
    specification: proposal.specification,
  });
  const trigger = await db.prisma.agentTrigger.findFirstOrThrow({
    where: { agentDefinitionId: created.agentDefinitionId! },
  });
  await db.prisma.agentRun.create({
    data: {
      agentDefinitionId: created.agentDefinitionId!,
      triggerId: trigger.id,
      idempotencyKey: 'historical-event',
      definitionSnapshot: { instructions: 'Original instructions' },
      input: { version: 1, context: [] },
    },
  });
  const edited = { ...proposal.specification, instructions: 'Updated investigation instructions' };
  const updated = await service.update({
    workspaceId,
    proposalId: proposal.id,
    revision: 1,
    specification: edited,
  });
  expect(updated.revision).toBe(2);
  expect(updated.agentDefinitionId).toBe(created.agentDefinitionId);
  expect(
    await db.prisma.agentDefinition.findUniqueOrThrow({ where: { id: created.agentDefinitionId! } })
  ).toMatchObject({ instructions: edited.instructions });
  expect(
    await db.prisma.agentTrigger.findUniqueOrThrow({ where: { id: trigger.id } })
  ).toMatchObject({ agentDefinitionId: created.agentDefinitionId });
  expect(
    await db.prisma.agentRun.findFirstOrThrow({ where: { triggerId: trigger.id } })
  ).toMatchObject({ definitionSnapshot: { instructions: 'Original instructions' } });
  await expect(
    service.update({ workspaceId, proposalId: proposal.id, revision: 1, specification: edited })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('rejects invalid providers and connections disconnected after proposing', async () => {
  await expect(
    service.propose({
      workspaceId,
      specification: {
        ...specification(),
        triggers: [
          {
            type: 'GITHUB_ISSUE',
            connectionId,
            description: 'Agent issues',
            config: {
              version: 1,
              repositoryIds: ['repo-1'],
              actions: ['opened', 'labeled'],
              labels: ['agent'],
            },
          },
        ],
      },
    })
  ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  const proposal = await service.propose({ workspaceId, specification: specification() });
  await db.prisma.agentConnection.update({
    where: { id: connectionId },
    data: { isEnabled: false, credentialsEncrypted: null },
  });
  const count = await db.prisma.agentDefinition.count();
  await expect(
    service.create({
      workspaceId,
      proposalId: proposal.id,
      revision: 1,
      specification: specification(),
    })
  ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(await db.prisma.agentDefinition.count()).toBe(count);
  await db.prisma.agentConnection.update({
    where: { id: connectionId },
    data: { isEnabled: true, credentialsEncrypted: 'encrypted' },
  });
});

for (const operation of ['remove first', 'reorder']) {
  it(`preserves trigger identities and historical source links when edits ${operation}`, async () => {
    const base = specification();
    const proposal = await service.propose({
      workspaceId,
      specification: {
        ...base,
        triggers: [
          base.triggers[0],
          { type: 'SCHEDULE', description: 'Daily QA', config: { version: 1, cadence: 'DAILY' } },
        ],
      },
    });
    const created = await service.create({
      workspaceId,
      proposalId: proposal.id,
      revision: 1,
      specification: proposal.specification,
    });
    const rows = await db.prisma.agentTrigger.findMany({
      where: { agentDefinitionId: created.agentDefinitionId! },
    });
    const slack = rows.find((row) => row.type === 'SLACK_MESSAGE')!;
    const schedule = rows.find((row) => row.type === 'SCHEDULE')!;
    await db.prisma.agentRun.create({
      data: {
        agentDefinitionId: created.agentDefinitionId!,
        triggerId: slack.id,
        idempotencyKey: 'source-history',
        definitionSnapshot: { instructions: 'Investigate bugs' },
        input: { version: 1, context: [] },
      },
    });
    const triggers =
      operation === 'remove first'
        ? created.specification.triggers.slice(1)
        : [...created.specification.triggers].reverse();
    await service.update({
      workspaceId,
      proposalId: proposal.id,
      revision: 1,
      specification: { ...created.specification, triggers },
    });
    expect(
      await db.prisma.agentTrigger.findUniqueOrThrow({ where: { id: slack.id } })
    ).toMatchObject({ type: 'SLACK_MESSAGE' });
    expect(
      await db.prisma.agentTrigger.findUniqueOrThrow({ where: { id: schedule.id } })
    ).toMatchObject({ type: 'SCHEDULE' });
    expect(
      await db.prisma.agentRun.findFirstOrThrow({ where: { triggerId: slack.id } })
    ).toMatchObject({ triggerId: slack.id });
    expect(
      await db.prisma.agentTrigger.count({
        where: { agentDefinitionId: created.agentDefinitionId! },
      })
    ).toBe(2);
  });
}

it('deletes the accepted proposal when its saved agent is deleted', async () => {
  const proposal = await service.propose({ workspaceId, specification: specification() });
  const created = await service.create({
    workspaceId,
    proposalId: proposal.id,
    revision: 1,
    specification: proposal.specification,
  });
  await db.prisma.agentDefinition.delete({ where: { id: created.agentDefinitionId! } });
  await expect(service.get(workspaceId, proposal.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it('refuses authoring while the workspace is archiving', async () => {
  await db.prisma.workspace.update({ where: { id: workspaceId }, data: { status: 'ARCHIVING' } });
  try {
    await expect(
      service.propose({ workspaceId, specification: specification() })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  } finally {
    await db.prisma.workspace.update({ where: { id: workspaceId }, data: { status: 'NEW' } });
  }
});

it('rejects missing workspaces and archived projects', async () => {
  await expect(
    service.propose({ workspaceId: 'missing', specification: specification() })
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await db.prisma.project.update({ where: { id: projectId }, data: { isArchived: true } });
  await expect(
    service.propose({ workspaceId, specification: specification() })
  ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
});
