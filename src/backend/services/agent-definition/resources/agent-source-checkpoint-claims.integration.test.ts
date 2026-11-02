import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { createLedgerFixture } from './testing/agent-ledger.test-support';

let db: IntegrationDatabase;
let source: typeof import('./agent-source.accessor').agentSourceAccessor;
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  source = (
    await vi.importActual<typeof import('./agent-source.accessor')>('./agent-source.accessor')
  ).agentSourceAccessor;
}, 30_000);
afterAll(async () => destroyIntegrationDatabase(db));
beforeEach(async () => {
  fixture = await createLedgerFixture(
    db,
    await vi.importActual<typeof import('../index')>('../index')
  );
  await source.prepareBaseline(fixture.connectionId, null);
});
async function legacy(boundary: 'B' | null = 'B') {
  const ids = boundary ? ['A', boundary] : ['A'];
  await db.prisma.agentSourcePage.createMany({
    data: [
      {
        connectionId: fixture.connectionId,
        scanId: 'target',
        ordinal: 0,
        phase: 'CAPTURE',
        requestPage: 1,
        evidence: { ids, entries: [{ providerEventId: 'A', eventId: 'retained-executable-id' }] },
      },
      {
        connectionId: fixture.connectionId,
        scanId: 'target',
        ordinal: 1,
        phase: 'VERIFY',
        requestPage: 1,
        evidence: { ids, entries: [] },
      },
      {
        connectionId: fixture.connectionId,
        scanId: 'target',
        ordinal: 2,
        phase: 'FINALIZED',
        requestPage: 1,
        sourceOrder: boundary ? 6 : 1,
        evidence: { ids: ['A'], entries: [] },
      },
    ],
  });
}
async function pins(orders: number[]) {
  await db.prisma.agentSourceBaseline.createMany({
    data: orders.map((sourceOrder, i) => ({
      id: `pin-${String(i).padStart(4, '0')}`,
      connectionId: fixture.connectionId,
      headEventId: 'B',
      sourceOrder,
    })),
  });
}
async function marker(scanId: string, order: number, head = 'B') {
  await db.prisma.agentSourceCheckpoint.create({
    data: {
      connectionId: fixture.connectionId,
      scanId,
      status: 'COMPLETE',
      headEventId: head,
      sourceOrder: order,
      entryCount: 1,
      heads: { create: { providerEventId: head, position: 0, precedingEventCount: 0 } },
    },
  });
  await db.prisma.agentSourcePage.create({
    data: {
      connectionId: fixture.connectionId,
      scanId,
      ordinal: 2,
      phase: 'FINALIZED',
      requestPage: 1,
      sourceOrder: order,
      evidence: { ids: [head], entries: [] },
    },
  });
}
async function maintain(times = 8) {
  for (let i = 0; i < times; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
}
async function checkpoint() {
  return await db.prisma.agentSourceCheckpoint.findUniqueOrThrow({
    where: { connectionId_scanId: { connectionId: fixture.connectionId, scanId: 'target' } },
  });
}
async function expectRejected() {
  const pages = await db.prisma.agentSourcePage.findMany();
  const baselines = await db.prisma.agentSourceBaseline.findMany();
  await maintain();
  expect(await checkpoint()).toMatchObject({ status: 'INVALID' });
  expect(await db.prisma.agentSourcePage.findMany()).toEqual(pages);
  expect(await db.prisma.agentSourceBaseline.findMany()).toEqual(baselines);
  await expect(source.prepareBaseline(fixture.connectionId, 'A')).rejects.toMatchObject({
    code: 'CONFLICT',
  });
}

it.each(['order', 'identity'])(
  'rejects a finalized marker whose %s disagrees with its own checkpoint',
  async (claim) => {
    await pins([5]);
    await marker('old', 5, 'C');
    await db.prisma.agentSourcePage.updateMany({
      where: { scanId: 'old' },
      data: claim === 'order' ? { sourceOrder: 9 } : { evidence: { ids: ['D'], entries: [] } },
    });
    await legacy();
    await expectRejected();
  }
);

it.each([3, 9])(
  'rejects an older interval baseline at %i that contradicts its retained head',
  async (order) => {
    await pins([5]);
    await marker('old', 4, 'C');
    await db.prisma.agentSourceBaseline.create({
      data: { connectionId: fixture.connectionId, headEventId: 'C', sourceOrder: order },
    });
    await legacy();
    await expectRejected();
  }
);

it.each(['previousBoundaryEventId', 'initialSourceOrder', 'entryCount', 'headEventId'] as const)(
  'restarts a bounded validation after consulted checkpoint claim %s changes',
  async (claim) => {
    await marker('old', 5);
    await padding();
    await legacy();
    await maintain(3);
    expect(await checkpoint()).toMatchObject({
      status: 'INDEXED',
      validationCursor: { phase: 'BASELINES' },
    });
    const before = await db.prisma.agentSourceState.findUniqueOrThrow({
      where: { connectionId: fixture.connectionId },
    });
    const data =
      claim === 'previousBoundaryEventId'
        ? { previousBoundaryEventId: 'C' }
        : claim === 'initialSourceOrder'
          ? { initialSourceOrder: 9 }
          : claim === 'entryCount'
            ? { entryCount: 2 }
            : { headEventId: 'C' };
    await db.prisma.agentSourceCheckpoint.update({
      where: { connectionId_scanId: { connectionId: fixture.connectionId, scanId: 'target' } },
      data,
    });
    const after = await db.prisma.agentSourceState.findUniqueOrThrow({
      where: { connectionId: fixture.connectionId },
    });
    expect(after.authorityRevision).toBeGreaterThan(before.authorityRevision);
    await expectRejected();
  }
);

async function padding() {
  await db.prisma.agentSourceBaseline.createMany({
    data: Array.from({ length: 250 }, (_, i) => ({
      id: `padding-${String(i).padStart(4, '0')}`,
      connectionId: fixture.connectionId,
      headEventId: 'unindexed',
      sourceOrder: 5,
    })),
  });
}

it.each(['marker-order', 'marker-identity', 'older-baseline'])(
  'rechecks %s after its authority was inspected in an earlier chunk',
  async (kind) => {
    await pins([5]);
    await marker('old', 4, 'C');
    await db.prisma.agentSourceBaseline.create({
      data: { id: 'old-pin', connectionId: fixture.connectionId, headEventId: 'C', sourceOrder: 4 },
    });
    await padding();
    await legacy();
    await maintain(3);
    expect(await checkpoint()).toMatchObject({
      status: 'INDEXED',
      validationCursor: { phase: 'BASELINES' },
    });
    if (kind === 'older-baseline') {
      await db.prisma.agentSourceBaseline.update({
        where: { id: 'old-pin' },
        data: { sourceOrder: 9 },
      });
    } else {
      await db.prisma.agentSourcePage.updateMany({
        where: { scanId: 'old' },
        data:
          kind === 'marker-order' ? { sourceOrder: 9 } : { evidence: { ids: ['D'], entries: [] } },
      });
    }
    await expectRejected();
  }
);

it('accepts agreeing duplicate baseline claims across older intervals and preserves issued IDs', async () => {
  await pins([5]);
  await marker('old', 4, 'C');
  await db.prisma.agentSourceBaseline.createMany({
    data: Array.from({ length: 250 }, (_, i) => ({
      id: `old-${i}`,
      connectionId: fixture.connectionId,
      headEventId: 'C',
      sourceOrder: 4,
    })),
  });
  const baselines = await db.prisma.agentSourceBaseline.findMany();
  await legacy();
  await maintain();
  expect(await checkpoint()).toMatchObject({ status: 'COMPLETE' });
  expect(await db.prisma.agentSourceBaseline.findMany()).toEqual(baselines);
  expect((await source.getBaseline(fixture.connectionId, 'old-0'))?.boundary?.sourceOrder).toBe(4);
});

it('forward migration invalidates pre-fence progress without rewriting retained claims', async () => {
  await marker('old', 5);
  await padding();
  await legacy();
  await maintain(3);
  expect(await checkpoint()).toMatchObject({
    status: 'INDEXED',
    validationCursor: { phase: 'BASELINES' },
  });
  const sqlite = new Database(db.databasePath);
  try {
    const oldMigration = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20261102163000_source_checkpoint_validation_fence/migration.sql'
      ),
      'utf8'
    );
    const oldTrigger = oldMigration
      .split('CREATE TRIGGER "AgentSourceCheckpoint_validation_update"')[1]
      ?.split('END;')[0];
    expect(oldTrigger).toBeDefined();
    sqlite.exec('DROP TRIGGER "AgentSourceCheckpoint_validation_update"');
    sqlite.exec(`CREATE TRIGGER "AgentSourceCheckpoint_validation_update"${oldTrigger}END;`);
    sqlite.exec('DROP INDEX "AgentSourceBaseline_connectionId_headEventId_sourceOrder_idx"');
    await db.prisma.agentSourceCheckpoint.update({
      where: { connectionId_scanId: { connectionId: fixture.connectionId, scanId: 'target' } },
      data: { initialSourceOrder: 9 },
    });
    const pages = await db.prisma.agentSourcePage.findMany();
    const heads = await db.prisma.agentSourceHead.findMany();
    const baselines = await db.prisma.agentSourceBaseline.findMany();
    const previous = await checkpoint();
    const state = await db.prisma.agentSourceState.findUniqueOrThrow({
      where: { connectionId: fixture.connectionId },
    });
    expect(previous.validationCursor).toMatchObject({ revision: state.authorityRevision });
    sqlite.exec(
      readFileSync(
        join(
          process.cwd(),
          'prisma/migrations/20261102190000_source_checkpoint_claims_fence/migration.sql'
        ),
        'utf8'
      )
    );
    expect(await checkpoint()).toEqual(previous);
    expect(await db.prisma.agentSourcePage.findMany()).toEqual(pages);
    expect(await db.prisma.agentSourceHead.findMany()).toEqual(heads);
    expect(await db.prisma.agentSourceBaseline.findMany()).toEqual(baselines);
    expect(
      (
        await db.prisma.agentSourceState.findUniqueOrThrow({
          where: { connectionId: fixture.connectionId },
        })
      ).authorityRevision
    ).toBeGreaterThan(state.authorityRevision);
  } finally {
    sqlite.close();
  }
  await expectRejected();
});

it('rejects a nonzero null-head pin even when the candidate boundary is non-null', async () => {
  await pins([5]);
  const pin = await db.prisma.agentSourceBaseline.create({
    data: { connectionId: fixture.connectionId, headEventId: null, sourceOrder: 9 },
  });
  await legacy();
  await expectRejected();
  expect((await source.getBaseline(fixture.connectionId, pin.id))?.boundary?.sourceOrder).toBe(9);
});

it.each([0, null])(
  'preserves a null-head pin with order %s alongside a non-null boundary',
  async (sourceOrder) => {
    await pins([5]);
    await db.prisma.agentSourceBaseline.create({
      data: { connectionId: fixture.connectionId, headEventId: null, sourceOrder },
    });
    const baselines = await db.prisma.agentSourceBaseline.findMany();
    await legacy();
    await maintain();
    expect(await checkpoint()).toMatchObject({ status: 'COMPLETE' });
    expect(await db.prisma.agentSourceBaseline.findMany()).toEqual(baselines);
    expect((await source.prepareBaseline(fixture.connectionId, 'A')).boundary?.sourceOrder).toBe(6);
  }
);
