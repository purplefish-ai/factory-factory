import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { createLedgerFixture } from './agent-ledger.test-support';

let db: IntegrationDatabase;
let runtime: typeof import('../index');
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
let service: InstanceType<typeof runtime.AgentProposalService>;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual<typeof import('../index')>('../index');
  service = new runtime.AgentProposalService();
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
});

async function author() {
  const original = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: fixture.definitionId },
  });
  const workspace = await db.prisma.workspace.create({
    data: { projectId: original.projectId, name: 'Author' },
  });
  const proposed = await service.propose({
    workspaceId: workspace.id,
    specification: {
      name: 'Saved agent',
      instructions: 'Original task',
      executionConfig: { version: 1, provider: 'CLAUDE', model: 'sonnet' },
      triggers: [
        {
          type: 'GITHUB_ISSUE',
          connectionId: fixture.connectionId,
          description: 'Agent label',
          config: { version: 1, repositoryIds: ['repo-1'], actions: ['labeled'] },
        },
      ],
    },
  });
  const accepted = await service.create({
    workspaceId: workspace.id,
    proposalId: proposed.id,
    revision: 1,
    specification: proposed.specification,
  });
  const definitionId = accepted.agentDefinitionId!;
  const trigger = await db.prisma.agentTrigger.findFirstOrThrow({
    where: { agentDefinitionId: definitionId },
  });
  await db.prisma.agentDefinition.update({
    where: { id: definitionId },
    data: { isEnabled: true },
  });
  await db.prisma.agentTrigger.update({
    where: { id: trigger.id },
    data: {
      isEnabled: true,
      activationState: 'ACTIVE',
      activationGeneration: 1,
      activationBoundary: { provider: 'GITHUB', headEventId: null, sourceOrder: 0 },
    },
  });
  return { workspaceId: workspace.id, proposal: accepted, definitionId, triggerId: trigger.id };
}

it('pauses execution edits, advances revisions, cancels queued work and preserves claimed snapshots', async () => {
  const saved = await author();
  await fixture.admit(await fixture.event('active'), {
    agentDefinitionId: saved.definitionId,
    triggerId: saved.triggerId,
  });
  const claim = await runtime.claimNextRun();
  expect(claim.status).toBe('CLAIMED');
  await fixture.admit(await fixture.event('waiting'), {
    agentDefinitionId: saved.definitionId,
    triggerId: saved.triggerId,
  });
  await service.update({
    workspaceId: saved.workspaceId,
    proposalId: saved.proposal.id,
    revision: 1,
    specification: { ...saved.proposal.specification, instructions: 'Changed task' },
  });
  expect(
    await db.prisma.agentDefinition.findUniqueOrThrow({ where: { id: saved.definitionId } })
  ).toMatchObject({ definitionRevision: 2 });
  expect(
    await db.prisma.agentTrigger.findUniqueOrThrow({ where: { id: saved.triggerId } })
  ).toMatchObject({ isEnabled: false, activationState: 'PAUSED', activationGeneration: 2 });
  const runs = await db.prisma.agentRun.findMany({
    where: { agentDefinitionId: saved.definitionId },
  });
  expect(runs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        status: 'RUNNING',
        definitionRevision: 1,
        definitionSnapshot: expect.objectContaining({ instructions: 'Original task' }),
      }),
      expect.objectContaining({ status: 'CANCELLED', reasonCode: 'STALE_REVISION' }),
    ])
  );
});

it('preserves activation and queued snapshots across a cosmetic name edit', async () => {
  const saved = await author();
  await fixture.admit(await fixture.event(), {
    agentDefinitionId: saved.definitionId,
    triggerId: saved.triggerId,
  });
  await service.update({
    workspaceId: saved.workspaceId,
    proposalId: saved.proposal.id,
    revision: 1,
    specification: { ...saved.proposal.specification, name: 'Renamed agent' },
  });
  expect(
    await db.prisma.agentDefinition.findUniqueOrThrow({ where: { id: saved.definitionId } })
  ).toMatchObject({ name: 'Renamed agent', definitionRevision: 1 });
  expect(
    await db.prisma.agentTrigger.findUniqueOrThrow({ where: { id: saved.triggerId } })
  ).toMatchObject({
    isEnabled: true,
    activationState: 'ACTIVE',
    activationGeneration: 1,
    triggerRevision: 1,
  });
  expect(await db.prisma.agentRun.findFirstOrThrow()).toMatchObject({
    status: 'QUEUED',
    definitionSnapshot: { name: 'Saved agent' },
  });
  expect(await runtime.claimNextRun()).toMatchObject({ status: 'CLAIMED' });
});

it('invalidates only the edited trigger and cancels its unclaimed runs', async () => {
  const saved = await author();
  await fixture.admit(await fixture.event(), {
    agentDefinitionId: saved.definitionId,
    triggerId: saved.triggerId,
  });
  await service.update({
    workspaceId: saved.workspaceId,
    proposalId: saved.proposal.id,
    revision: 1,
    specification: {
      ...saved.proposal.specification,
      triggers: saved.proposal.specification.triggers.map((trigger) => ({
        ...trigger,
        filterInstructions: 'Only urgent reports',
      })),
    },
  });
  expect(
    await db.prisma.agentDefinition.findUniqueOrThrow({ where: { id: saved.definitionId } })
  ).toMatchObject({ definitionRevision: 1 });
  expect(
    await db.prisma.agentTrigger.findUniqueOrThrow({ where: { id: saved.triggerId } })
  ).toMatchObject({ triggerRevision: 2, activationGeneration: 2, isEnabled: false });
  expect(await db.prisma.agentRun.findFirstOrThrow()).toMatchObject({
    status: 'CANCELLED',
    reasonCode: 'STALE_REVISION',
  });
});

it.each(['GITHUB', 'SLACK', 'SCHEDULE'] as const)(
  'preserves evaluated history when changing a trigger source to %s',
  async (target) => {
    const saved = await author();
    const ownership = { agentDefinitionId: saved.definitionId, triggerId: saved.triggerId };
    await fixture.admit(await fixture.event('claimed'), ownership);
    const claim = await runtime.claimNextRun();
    if (claim.status !== 'CLAIMED') {
      throw new Error(JSON.stringify(claim));
    }
    const claimedBefore = await db.prisma.agentRun.findUniqueOrThrow({
      where: { id: claim.runId },
    });
    await fixture.admit(await fixture.event('waiting'), ownership);
    for (const status of ['SKIPPED', 'ERROR'] as const) {
      await fixture.evaluation(await fixture.event(status), { ...ownership, status });
    }
    const historyBefore = await db.prisma.agentEvaluation.findMany({
      where: { triggerId: saved.triggerId },
      orderBy: { id: 'asc' },
    });
    const connection =
      target === 'SCHEDULE'
        ? null
        : await db.prisma.agentConnection.create({
            data: {
              provider: target,
              externalId: target === 'SLACK' ? 'T-second' : 'gh:repo-2',
              name: 'Second source',
              credentialsEncrypted: target === 'SLACK' ? 'encrypted' : null,
            },
          });
    const originalTrigger = saved.proposal.specification.triggers[0];
    if (!originalTrigger) {
      throw new Error('The saved trigger is missing');
    }
    const replacement =
      target === 'SCHEDULE'
        ? {
            id: originalTrigger.id,
            type: 'SCHEDULE',
            description: 'Daily',
            config: { version: 1, cadence: 'DAILY' },
          }
        : target === 'SLACK'
          ? {
              id: originalTrigger.id,
              type: 'SLACK_MESSAGE',
              description: 'Feedback',
              connectionId: connection?.id,
              config: { version: 1, channelIds: ['C-second'] },
            }
          : {
              ...originalTrigger,
              connectionId: connection?.id,
              config: { version: 1, repositoryIds: ['repo-2'], actions: ['labeled'] },
            };
    await service.update({
      workspaceId: saved.workspaceId,
      proposalId: saved.proposal.id,
      revision: 1,
      specification: { ...saved.proposal.specification, triggers: [replacement] },
    });
    expect(
      await db.prisma.agentTrigger.findUniqueOrThrow({ where: { id: saved.triggerId } })
    ).toMatchObject({
      connectionId: connection?.id ?? null,
      isEnabled: false,
      activationState: 'PAUSED',
      activationGeneration: 2,
      triggerRevision: 2,
    });
    expect(
      await db.prisma.agentEvaluation.findMany({
        where: { triggerId: saved.triggerId },
        orderBy: { id: 'asc' },
      })
    ).toEqual(historyBefore);
    expect(historyBefore).toHaveLength(4);
    expect(
      historyBefore.every((evaluation) => evaluation.connectionId === fixture.connectionId)
    ).toBe(true);
    expect(await db.prisma.agentRun.findUniqueOrThrow({ where: { id: claim.runId } })).toEqual(
      claimedBefore
    );
    expect(
      await db.prisma.agentRun.findFirstOrThrow({
        where: { triggerId: saved.triggerId, id: { not: claim.runId } },
      })
    ).toMatchObject({
      status: 'CANCELLED',
      reasonCode: 'STALE_REVISION',
      triggerSnapshot: { connectionId: fixture.connectionId },
    });
  }
);
