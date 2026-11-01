import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { createLedgerFixture } from './testing/agent-ledger.test-support';
let db: IntegrationDatabase;
let runtime: typeof import('../index');
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual('../index');
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
});
async function smallBatch(activeGlobal = 4) {
  const { configService } = await vi.importActual<
    typeof import('@/backend/services/config.service')
  >('@/backend/services/config.service');
  vi.spyOn(configService, 'getAgentRuntimeLimits').mockReturnValue({
    ...configService.getAgentRuntimeLimits(),
    queueBatchSize: 2,
    activeGlobal,
  });
}
async function queue(id: string) {
  const result = await fixture.admit(await fixture.event(id));
  if (!('runId' in result)) {
    throw new Error(JSON.stringify(result));
  }
  return result.runId;
}
async function otherDefinition(id: string) {
  const base = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: fixture.definitionId },
  });
  const definition = await db.prisma.agentDefinition.create({
    data: { projectId: base.projectId, name: id, instructions: 'Other task', isEnabled: true },
  });
  const trigger = await db.prisma.agentTrigger.findUniqueOrThrow({
    where: { id: fixture.triggerId },
  });
  await db.prisma.agentTrigger.create({
    data: {
      id,
      agentDefinitionId: definition.id,
      connectionId: trigger.connectionId,
      type: 'GITHUB_ISSUE',
      description: 'Other definition trigger',
      isEnabled: true,
      activationState: 'ACTIVE',
      activationGeneration: 1,
      activationBoundary: { provider: 'GITHUB', headEventId: null, sourceOrder: 0 },
      config: { version: 1, repositoryIds: ['repo-1'], actions: ['labeled'] },
    },
  });
  const eventId = await fixture.event(id);
  const result = await fixture.admit(eventId, { agentDefinitionId: definition.id, triggerId: id });
  if (!('runId' in result)) {
    throw new Error(JSON.stringify(result));
  }
  return result.runId;
}
it('maintains at most one batch per call and eventually expires every queue row even at full capacity', async () => {
  await smallBatch(1);
  await queue('running');
  await runtime.claimNextRun();
  for (let i = 0; i < 5; i++) {
    await queue(`expired-${i}`);
  }
  await db.prisma.agentRun.updateMany({
    where: { status: 'QUEUED' },
    data: { expiresAt: new Date(0) },
  });
  await runtime.claimNextRun();
  expect(await db.prisma.agentRun.count({ where: { status: 'CANCELLED' } })).toBe(2);
  await runtime.claimNextRun();
  await runtime.claimNextRun();
  expect(
    await db.prisma.agentRun.count({ where: { status: 'CANCELLED', reasonCode: 'QUEUE_EXPIRED' } })
  ).toBe(5);
});
it('claims a later definition beyond a capacity-blocked prefix while keeping FIFO within the first definition', async () => {
  await smallBatch();
  const running = await queue('running');
  await runtime.claimNextRun();
  const first = await queue('first');
  await queue('second');
  await queue('third');
  const other = await otherDefinition('trigger-z');
  expect(await runtime.claimNextRun()).toMatchObject({ status: 'CLAIMED', runId: other });
  await db.prisma.agentRun.update({ where: { id: running }, data: { status: 'COMPLETED' } });
  expect(await runtime.claimNextRun()).toMatchObject({ status: 'CLAIMED', runId: first });
});
it('serializes global capacity races across definitions', async () => {
  await queue('first');
  for (let i = 0; i < 4; i++) {
    await otherDefinition(`trigger-${i}`);
  }
  const results = await Promise.all(Array.from({ length: 5 }, () => runtime.claimNextRun()));
  expect(results.filter((result) => result.status === 'CLAIMED')).toHaveLength(4);
  expect(await db.prisma.agentRun.count({ where: { status: 'RUNNING' } })).toBe(4);
  expect(await db.prisma.agentRun.count({ where: { status: 'QUEUED' } })).toBe(1);
});
it('does not launch a later run while its definition FIFO head is deferred', async () => {
  const first = await queue('first');
  await queue('second');
  await db.prisma.agentRun.update({
    where: { id: first },
    data: { nextAttemptAt: new Date(Date.now() + 60_000) },
  });
  expect(await runtime.claimNextRun()).toEqual({ status: 'DEFERRED', reason: 'WAITING' });
  expect(await db.prisma.agentRun.count({ where: { status: 'RUNNING' } })).toBe(0);
});
it('does not revive an overflowed definition/event through a later matching trigger', async () => {
  const { configService } = await vi.importActual<
    typeof import('@/backend/services/config.service')
  >('@/backend/services/config.service');
  vi.spyOn(configService, 'getAgentRuntimeLimits').mockReturnValue({
    ...configService.getAgentRuntimeLimits(),
    waitingPerDefinition: 1,
  });
  const existing = await queue('first');
  await fixture.secondTrigger();
  const eventId = await fixture.event('overflow');
  expect(await fixture.admit(eventId)).toMatchObject({
    status: 'REJECTED',
    reason: 'QUEUE_OVERFLOW',
  });
  await db.prisma.agentRun.update({ where: { id: existing }, data: { status: 'CANCELLED' } });
  expect(await fixture.admit(eventId, { triggerId: 'trigger-b' })).toMatchObject({
    status: 'REJECTED',
    reason: 'QUEUE_OVERFLOW',
  });
  expect(await db.prisma.agentRun.count({ where: { eventId } })).toBe(0);
});

it('claims a ready definition beyond a page of future-due FIFO heads', async () => {
  await smallBatch();
  const first = await queue('future-a');
  const second = await otherDefinition('future-b');
  const ready = await otherDefinition('ready-c');
  const now = new Date();
  await db.prisma.agentRun.updateMany({
    where: { id: { in: [first, second] } },
    data: { nextAttemptAt: new Date(now.getTime() + 60_000) },
  });

  expect(await runtime.claimNextRun(now)).toMatchObject({ status: 'CLAIMED', runId: ready });
  expect(await db.prisma.agentRun.findUniqueOrThrow({ where: { id: first } })).toMatchObject({
    status: 'QUEUED',
  });
  expect(await db.prisma.agentRun.findUniqueOrThrow({ where: { id: second } })).toMatchObject({
    status: 'QUEUED',
  });
  expect(await runtime.claimNextRun(new Date(now.getTime() + 60_000))).toMatchObject({
    status: 'CLAIMED',
    runId: first,
  });
});

it('reprocesses rolled-back maintenance before moving to the next batch', async () => {
  await smallBatch();
  const first = await queue('expired-a');
  const second = await queue('expired-b');
  const ready = await otherDefinition('ready-after-rollback');
  await db.prisma.agentRun.updateMany({
    where: { id: { in: [first, second] } },
    data: { expiresAt: new Date(0) },
  });
  await db.prisma.$executeRawUnsafe(
    "CREATE TRIGGER reject_test_claim BEFORE UPDATE OF status ON AgentRun WHEN NEW.status = 'RUNNING' BEGIN SELECT RAISE(ABORT, 'Injected claim failure'); END"
  );
  try {
    await expect(runtime.claimNextRun()).rejects.toMatchObject({ code: 'P2003' });
    expect(
      await db.prisma.agentRun.count({ where: { id: { in: [first, second] }, status: 'QUEUED' } })
    ).toBe(2);
  } finally {
    await db.prisma.$executeRawUnsafe('DROP TRIGGER reject_test_claim');
  }
  expect(await runtime.claimNextRun()).toMatchObject({ status: 'CLAIMED', runId: ready });
  expect(
    await db.prisma.agentRun.count({
      where: { id: { in: [first, second] }, status: 'CANCELLED', reasonCode: 'QUEUE_EXPIRED' },
    })
  ).toBe(2);
});
