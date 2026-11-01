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
let triggerId: string;
const event = (id?: string) => fixture.event(id);
const admit = (id: string, overrides?: Record<string, unknown>) => fixture.admit(id, overrides);
beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual<typeof import('../index')>('../index');
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
  ({ triggerId } = fixture);
});

it('claims FIFO once and includes provisioning and ambiguous dispatches in definition capacity', async () => {
  await admit(await event('first'));
  await admit(await event('second'));
  expect(runtime.claimNextRun).toBeTypeOf('function');
  const oldest = await db.prisma.agentRun.findFirstOrThrow({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const claims = await Promise.all([runtime.claimNextRun(), runtime.claimNextRun()]);
  expect(claims).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        status: 'CLAIMED',
        runId: oldest.id,
        workerGeneration: 1,
        attemptGeneration: 1,
      }),
      { status: 'DEFERRED', reason: 'CAPACITY' },
    ])
  );
  expect(await db.prisma.agentRun.findUniqueOrThrow({ where: { id: oldest.id } })).toMatchObject({
    status: 'RUNNING',
    launchPhase: 'PROVISIONING',
  });
  await db.prisma.agentRun.update({
    where: { id: oldest.id },
    data: { launchPhase: 'NEEDS_ATTENTION' },
  });
  await db.prisma.agentInitialDelivery.update({
    where: { runId: oldest.id },
    data: { state: 'AMBIGUOUS', sendingAt: new Date() },
  });
  expect(await db.prisma.agentRun.findUniqueOrThrow({ where: { id: oldest.id } })).toMatchObject({
    status: 'RUNNING',
    launchPhase: 'NEEDS_ATTENTION',
  });
  expect(
    await db.prisma.agentInitialDelivery.findUniqueOrThrow({ where: { runId: oldest.id } })
  ).toMatchObject({ state: 'AMBIGUOUS' });
  expect(await runtime.claimNextRun()).toEqual({ status: 'DEFERRED', reason: 'CAPACITY' });
  await db.prisma.agentInitialDelivery.update({
    where: { runId: oldest.id },
    data: { state: 'FINISHED', finishedAt: new Date() },
  });
  await db.prisma.agentRun.update({
    where: { id: oldest.id },
    data: { status: 'COMPLETED', launchPhase: 'FINISHED' },
  });
  expect(await runtime.claimNextRun()).toMatchObject({ status: 'CLAIMED' });
});

it.each(['paused', 'revision'] as const)(
  'cancels queued work if %s wins the launch-claim transaction',
  async (change) => {
    await admit(await event());
    expect(runtime.claimNextRun).toBeTypeOf('function');
    await db.prisma.agentTrigger.update({
      where: { id: triggerId },
      data: change === 'paused' ? { isEnabled: false } : { triggerRevision: 2 },
    });
    expect(await runtime.claimNextRun()).toEqual({ status: 'DEFERRED', reason: 'EMPTY' });
    expect(await db.prisma.agentRun.findFirstOrThrow()).toMatchObject({
      status: 'CANCELLED',
      launchPhase: 'FINISHED',
      reasonCode: change === 'paused' ? 'TRIGGER_DISABLED' : 'STALE_REVISION',
    });
    expect(await db.prisma.agentInitialDelivery.findFirstOrThrow()).toMatchObject({
      state: 'FINISHED',
    });
  }
);

it('expires queued work after 24 hours with an explicit durable reason', async () => {
  await admit(await event());
  expect(runtime.claimNextRun).toBeTypeOf('function');
  await db.prisma.agentRun.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
  expect(await runtime.claimNextRun()).toEqual({ status: 'DEFERRED', reason: 'EMPTY' });
  expect(await db.prisma.agentRun.findFirstOrThrow()).toMatchObject({
    status: 'CANCELLED',
    reasonCode: 'QUEUE_EXPIRED',
  });
});
