import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
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
  const runtime = await vi.importActual<typeof import('../index')>('../index');
  fixture = await createLedgerFixture(db, runtime);
  await source.prepareBaseline(fixture.connectionId, null);
});

async function legacy(verification: string[][], count = 2) {
  const ids = Array.from({ length: count }, (_, i) => `head-${i}`);
  const capturePages = Array.from({ length: Math.ceil(count / 100) }, (_, i) =>
    ids.slice(i * 100, (i + 1) * 100)
  );
  await db.prisma.agentSourcePage.createMany({
    data: [
      ...capturePages.map((page, i) => ({
        connectionId: fixture.connectionId,
        scanId: 'target',
        ordinal: i,
        phase: 'CAPTURE',
        requestPage: i + 1,
        nextPage: i === capturePages.length - 1 ? null : i + 2,
        evidence: {
          ids: page,
          entries: page.map((providerEventId) => ({ providerEventId, eventId: null })),
        },
      })),
      ...verification.map((page, i) => ({
        connectionId: fixture.connectionId,
        scanId: 'target',
        ordinal: capturePages.length + i,
        phase: 'VERIFY',
        requestPage: i + 1,
        nextPage: i === verification.length - 1 ? null : i + 2,
        evidence: { ids: page, entries: [] },
      })),
      {
        connectionId: fixture.connectionId,
        scanId: 'target',
        ordinal: capturePages.length + verification.length,
        phase: 'FINALIZED',
        requestPage: 1,
        sourceOrder: 0,
        evidence: { ids: ['head-0'], entries: [] },
      },
    ],
  });
  return capturePages.length + verification.length + 1;
}
async function maintain(times: number) {
  for (let i = 0; i < times; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
}
async function checkpoint() {
  return await db.prisma.agentSourceCheckpoint.findUniqueOrThrow({
    where: { connectionId_scanId: { connectionId: fixture.connectionId, scanId: 'target' } },
  });
}

it.each([[['head-0'], ['unknown', 'head-1']], [['head-1', 'head-0', 'head-1']]])(
  'retains invalid legacy verification with skipped gap or future identity: %j',
  async (...verification) => {
    await legacy(verification);
    const pages = await db.prisma.agentSourcePage.findMany();
    await maintain(8);
    expect(await checkpoint()).toMatchObject({ status: 'INVALID' });
    expect(await db.prisma.agentSourcePage.findMany()).toEqual(pages);
  }
);

it.each([
  [['head-0'], ['head-0', 'head-1']],
  [['new-prefix', 'head-0', 'head-1']],
  [['head-0', 'head-1']],
])('accepts legitimate shifted prefix and verified overlap: %j', async (...verification) => {
  await legacy(verification);
  await maintain(8);
  expect(await checkpoint()).toMatchObject({ status: 'COMPLETE' });
  expect(await db.prisma.agentSourcePage.count()).toBe(1);
});

async function largeInterval() {
  const ids = Array.from({ length: 250 }, (_, i) => `head-${i}`);
  const pages = await legacy([ids.slice(0, 100), ids.slice(100, 200), ids.slice(200)], ids.length);
  await maintain(pages);
}

it('requires multiple bounded validation transactions before publishing a large interval', async () => {
  await largeInterval();
  expect(await checkpoint()).toMatchObject({ status: 'INDEXED' });
  expect(await db.prisma.agentSourcePage.count()).toBe(7);
  await maintain(1);
  expect(await checkpoint()).toMatchObject({ status: 'INDEXED' });
  // Each head now reserves itself plus two indexed baseline witnesses in the same budget.
  await maintain(7);
  expect(await checkpoint()).toMatchObject({ status: 'COMPLETE' });
  await maintain(1);
  expect(await db.prisma.agentSourcePage.count()).toBe(1);
});

it.each(['baseline', 'checkpoint'])(
  'rechecks earlier chunks after interleaved %s authority changes',
  async (authority) => {
    await largeInterval();
    expect(await checkpoint()).toMatchObject({ status: 'INDEXED' });
    if (authority === 'baseline') {
      await db.prisma.agentSourceBaseline.create({
        data: { connectionId: fixture.connectionId, headEventId: 'head-0', sourceOrder: 7 },
      });
    } else {
      await db.prisma.agentSourceCheckpoint.create({
        data: {
          connectionId: fixture.connectionId,
          scanId: 'earlier-authority',
          status: 'COMPLETE',
          sourceOrder: 7,
          heads: { create: { providerEventId: 'head-0', position: 0, precedingEventCount: 0 } },
        },
      });
    }
    await maintain(8);
    expect(await checkpoint()).toMatchObject({ status: 'INVALID' });
    expect(await db.prisma.agentSourcePage.count()).toBe(7);
  }
);

it('restarts baseline validation when an already inspected pin changes', async () => {
  await db.prisma.agentSourceBaseline.createMany({
    data: Array.from({ length: 250 }, (_, i) => ({
      id: `pin-${String(i).padStart(4, '0')}`,
      connectionId: fixture.connectionId,
      headEventId: 'head-0',
      sourceOrder: 0,
    })),
  });
  const pages = await legacy([['head-0', 'head-1']]);
  await maintain(pages);
  expect(await checkpoint()).toMatchObject({
    status: 'INDEXED',
    validationCursor: { phase: 'BASELINES' },
  });
  await db.prisma.agentSourceBaseline.update({
    where: { id: 'pin-0000' },
    data: { sourceOrder: 9 },
  });
  await maintain(5);
  expect(await checkpoint()).toMatchObject({ status: 'INVALID' });
  expect(await db.prisma.agentSourcePage.count()).toBe(3);
});

it('bounds actual joined authority rows and records the fixture writer-lock scope', async () => {
  const ids = Array.from({ length: 1250 }, (_, i) => `head-${i}`);
  const pages = await legacy(
    Array.from({ length: 13 }, (_, i) => ids.slice(i * 100, (i + 1) * 100)),
    ids.length
  );
  await db.prisma.agentSourceBaseline.createMany({
    data: Array.from({ length: 250 }, (_, i) => ({
      connectionId: fixture.connectionId,
      headEventId: `head-${i}`,
      sourceOrder: 0,
    })),
  });
  await maintain(pages);
  const { checkpointPromotionStatus } = await vi.importActual<
    typeof import('./agent-source-checkpoint-promotion')
  >('./agent-source-checkpoint-promotion');
  const inspected: number[] = [];
  const lockMs: number[] = [];
  for (let i = 0; i < 50 && (await checkpoint()).status === 'INDEXED'; i++) {
    await db.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "AgentDefinition" SET "definitionRevision" = "definitionRevision" WHERE 0`;
      const started = performance.now();
      const raw = vi.spyOn(tx, '$queryRaw');
      raw.mockClear();
      const data = await checkpointPromotionStatus(tx, fixture.connectionId, 'target');
      if (data) {
        await tx.agentSourceCheckpoint.update({
          where: { connectionId_scanId: { connectionId: fixture.connectionId, scanId: 'target' } },
          data,
        });
      }
      let count = 0;
      for (const result of raw.mock.results) {
        const rows = await result.value;
        expect(Array.isArray(rows)).toBe(true);
        count += rows.length;
        const witnesses = z
          .array(
            z.object({
              baselineMinimum: z.number().nullable().optional(),
              baselineMaximum: z.number().nullable().optional(),
            })
          )
          .parse(rows);
        count += witnesses.filter((row) => row.baselineMinimum != null).length;
        count += witnesses.filter((row) => row.baselineMaximum != null).length;
      }
      lockMs.push(performance.now() - started);
      const queries = [...raw.mock.calls];
      raw.mockRestore();
      for (const [template, ...values] of queries) {
        const segments = z.array(z.string()).parse(template);
        const sql = segments.join('?');
        const plan = z
          .array(z.object({ detail: z.string() }))
          .parse(await tx.$queryRawUnsafe(`EXPLAIN QUERY PLAN ${sql}`, ...values));
        expect(plan.some((row) => row.detail.includes('USE TEMP B-TREE'))).toBe(false);
        expect(plan.some((row) => /SCAN (authority|baseline|page|pin)/.test(row.detail))).toBe(
          false
        );
        if (sql.includes('FROM "AgentSourceHead" authority')) {
          expect(
            plan.filter((row) => row.detail.includes('SEARCH pin USING COVERING INDEX'))
          ).toHaveLength(2);
        }
      }
      inspected.push(count);
    });
  }
  expect(inspected.length).toBeGreaterThan(10);
  expect(inspected.every((count) => count <= 100)).toBe(true);
  // Finalization inspected one marker, 33 heads and their 66 baseline extrema (100 rows).
  expect(inspected.reduce((sum, count) => sum + count, 100)).toBe(2002);
  expect(await checkpoint()).toMatchObject({ status: 'COMPLETE' });
  expect(await db.prisma.agentSourceHead.count()).toBe(1250);
  expect(await db.prisma.agentSourceBaseline.count()).toBe(251);
  process.stdout.write(
    `checkpoint validation fixture ${JSON.stringify({ heads: 1250, baselines: 251, inspected, lockMs })}\n`
  );
});

it('defers promotion for an unindexed marker and advances after its authority becomes available', async () => {
  await legacy([['head-0', 'head-1']]);
  await db.prisma.agentSourcePage.create({
    data: {
      connectionId: fixture.connectionId,
      scanId: 'z-unindexed',
      ordinal: 2,
      phase: 'FINALIZED',
      requestPage: 1,
      sourceOrder: 0,
      evidence: { ids: ['older-head'], entries: [] },
    },
  });
  const pages = await db.prisma.agentSourcePage.findMany();
  await maintain(3);
  expect(await checkpoint()).toMatchObject({ status: 'INDEXED', validationCursor: null });
  expect(await db.prisma.agentSourcePage.findMany()).toEqual(pages);
  await db.prisma.agentSourceCheckpoint.create({
    data: {
      connectionId: fixture.connectionId,
      scanId: 'z-unindexed',
      status: 'COMPLETE',
      headEventId: 'older-head',
      sourceOrder: 0,
      entryCount: 1,
      heads: { create: { providerEventId: 'older-head', position: 0, precedingEventCount: 0 } },
    },
  });
  await maintain(1);
  expect(await checkpoint()).toMatchObject({ status: 'COMPLETE' });
  expect(await db.prisma.agentSourcePage.findMany()).toEqual(pages);
});
