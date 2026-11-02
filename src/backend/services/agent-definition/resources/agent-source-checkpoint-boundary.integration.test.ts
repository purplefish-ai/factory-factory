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
async function marker(scanId: string, order: number, headOrder = order, malformed = false) {
  await db.prisma.agentSourceCheckpoint.create({
    data: {
      connectionId: fixture.connectionId,
      scanId,
      status: 'COMPLETE',
      headEventId: 'B',
      sourceOrder: headOrder,
      entryCount: 1,
      heads: { create: { providerEventId: 'B', position: 0, precedingEventCount: 0 } },
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
      evidence: malformed ? {} : { ids: ['B'], entries: [] },
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

it('rejects legacy boundary baseline witnesses 5 and9 instead of publishing A at6', async () => {
  await pins([5, 9]);
  await legacy();
  await expectRejected();
});

it.each(['marker', 'head', 'malformed-marker'])(
  'checks every retained boundary %s witness as well as baseline pins',
  async (kind) => {
    await pins([5]);
    await marker(
      'witness',
      kind === 'marker' ? 9 : 5,
      kind === 'head' ? 9 : 5,
      kind === 'malformed-marker'
    );
    await legacy();
    await expectRejected();
  }
);

it('rejects conflicting boundary markers without a baseline pin', async () => {
  await marker('a-witness', 5);
  await marker('z-witness', 9);
  await legacy();
  await expectRejected();
});

it.each(['baselines', 'marker'])(
  'publishes only after agreeing %s prove the boundary and preserves issued IDs',
  async (kind) => {
    if (kind === 'baselines') {
      await pins([5, 5]);
    } else {
      await marker('witness', 5);
    }
    const baselines = await db.prisma.agentSourceBaseline.findMany();
    await legacy();
    await maintain();
    expect(await checkpoint()).toMatchObject({ status: 'COMPLETE', initialSourceOrder: 5 });
    expect((await source.prepareBaseline(fixture.connectionId, 'A')).boundary?.sourceOrder).toBe(6);
    for (const baseline of baselines) {
      expect(
        (await source.getBaseline(fixture.connectionId, baseline.id))?.boundary?.sourceOrder
      ).toBe(baseline.sourceOrder);
    }
  }
);

it('retains a boundary with no independent canonical witness', async () => {
  await legacy();
  await expectRejected();
});

it.each(['baseline', 'marker', 'head'])(
  'rechecks previously inspected boundary %s witnesses after changes between bounded chunks',
  async (kind) => {
    await pins(Array.from({ length: 250 }, () => 5));
    await marker('witness', 5);
    await legacy();
    await maintain(3);
    expect(await checkpoint()).toMatchObject({ status: 'INDEXED' });
    if (kind === 'baseline') {
      await db.prisma.agentSourceBaseline.update({
        where: { id: 'pin-0000' },
        data: { sourceOrder: 9 },
      });
    } else if (kind === 'marker') {
      await db.prisma.agentSourcePage.updateMany({
        where: { scanId: 'witness' },
        data: { sourceOrder: 9 },
      });
    } else {
      await db.prisma.agentSourceCheckpoint.update({
        where: { connectionId_scanId: { connectionId: fixture.connectionId, scanId: 'witness' } },
        data: { sourceOrder: 9 },
      });
    }
    await expectRejected();
  }
);

it('restarts older validation cursors before trusting their unexamined boundary witnesses', async () => {
  await pins([5, 9, ...Array.from({ length: 248 }, () => 5)]);
  await legacy();
  await maintain(2);
  // Simulate the old finalization/cursor after it skipped the conflicting boundary pin.
  await db.prisma.agentSourceCheckpoint.update({
    where: { connectionId_scanId: { connectionId: fixture.connectionId, scanId: 'target' } },
    data: { status: 'INDEXED', sourceOrder: 6, initialSourceOrder: 5, nextOrdinal: 3 },
  });
  const state = await db.prisma.agentSourceState.findUniqueOrThrow({
    where: { connectionId: fixture.connectionId },
  });
  await db.prisma.agentSourceCheckpoint.update({
    where: { connectionId_scanId: { connectionId: fixture.connectionId, scanId: 'target' } },
    data: {
      validationCursor: {
        revision: state.authorityRevision,
        phase: 'BASELINES',
        scanId: 'target',
        position: 0,
        baselineId: 'pin-0100',
        headCount: 1,
      },
    },
  });
  await expectRejected();
});

it('rejects conflicting canonical witnesses for an empty previous boundary', async () => {
  await db.prisma.agentSourceBaseline.create({
    data: { connectionId: fixture.connectionId, headEventId: null, sourceOrder: 9 },
  });
  await legacy(null);
  await expectRejected();
});
