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
  const runtime = await vi.importActual<typeof import('../index')>('../index');
  source = (
    await vi.importActual<typeof import('./agent-source.accessor')>('./agent-source.accessor')
  ).agentSourceAccessor;
  fixture = await createLedgerFixture(db, runtime);
}, 30_000);
afterAll(async () => destroyIntegrationDatabase(db));
beforeEach(async () => {
  const runtime = await vi.importActual<typeof import('../index')>('../index');
  fixture = await createLedgerFixture(db, runtime);
  await source.prepareBaseline(fixture.connectionId, null);
});

async function interval() {
  const events = [
    { providerEventId: 'unsupported-new', payload: null },
    { providerEventId: 'label-new', payload: fixture.github('label-new').payload },
    { providerEventId: 'unsupported-middle', payload: null },
    { providerEventId: 'label-old', payload: fixture.github('label-old').payload },
    { providerEventId: 'unsupported-old', payload: null },
  ];
  const pending = await source.prepareBaseline(fixture.connectionId, 'unsupported-middle');
  await source.savePage(fixture.connectionId, 1, { events, nextPage: null });
  await source.savePage(fixture.connectionId, 1, { events, nextPage: null });
  await source.finalizeNextChunk(fixture.connectionId);
  return pending;
}

it('fences committed-head preparation after rejected proof while preserving issued ID reads', async () => {
  const pending = await interval();
  const answer = await source.getBaseline(fixture.connectionId, pending.id);
  await db.prisma.agentSourceCheckpoint.updateMany({ data: { status: 'INVALID' } });
  await expect(
    source.prepareBaseline(fixture.connectionId, 'unsupported-new')
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await source.getBaseline(fixture.connectionId, pending.id)).toEqual(answer);
});

it('rejects an uncaptured identity between verification pages before legacy compaction', async () => {
  await db.prisma.agentSourceState.deleteMany();
  await source.prepareBaseline(fixture.connectionId, 'anchor');
  const first = [{ providerEventId: 'head', payload: null }];
  const tail = [
    { providerEventId: 'tail', payload: null },
    { providerEventId: 'anchor', payload: null },
  ];
  await source.savePage(fixture.connectionId, 1, { events: first, nextPage: 2 });
  await source.savePage(fixture.connectionId, 2, { events: tail, nextPage: 3 });
  await source.savePage(fixture.connectionId, 1, { events: first, nextPage: 2 });
  await source.savePage(fixture.connectionId, 2, { events: tail, nextPage: 3 });
  await source.finalizeNextChunk(fixture.connectionId);
  await db.prisma.agentSourceCheckpoint.deleteMany();
  await db.prisma.agentSourcePage.updateMany({
    where: { phase: 'VERIFY', requestPage: 2 },
    data: { evidence: { ids: ['uncaptured', 'tail', 'anchor'], entries: [] } },
  });
  const pages = await db.prisma.agentSourcePage.findMany();
  for (let i = 0; i < 8; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({ status: 'INVALID' });
  expect(await db.prisma.agentSourcePage.findMany()).toEqual(pages);
});

it('replays a discarded shifted-overlap observation without invalidating a valid interval', async () => {
  await db.prisma.agentSourceState.deleteMany();
  await source.prepareBaseline(fixture.connectionId, 'anchor');
  const events = Array.from({ length: 205 }, (_, i) => ({
    providerEventId: `head-${i}`,
    payload: null,
  }));
  const pages = [
    events.slice(0, 100),
    events.slice(100, 200),
    [...events.slice(200), { providerEventId: 'anchor', payload: null }],
  ];
  for (let i = 0; i < 3; i++) {
    await source.savePage(fixture.connectionId, i + 1, {
      events: pages[i] ?? [],
      nextPage: i === 2 ? null : i + 2,
    });
  }
  await source.savePage(fixture.connectionId, 1, { events: pages[0] ?? [], nextPage: 2 });
  await source.savePage(fixture.connectionId, 2, { events: pages[1] ?? [], nextPage: 3 });
  await source.resume(fixture.connectionId);
  await source.savePage(fixture.connectionId, 2, {
    events: [
      { providerEventId: 'inserted', payload: null },
      { providerEventId: 'head-100', payload: null },
      { providerEventId: 'head-200', payload: null },
      { providerEventId: 'discarded-tail', payload: null },
    ],
    nextPage: 3,
  });
  expect((await source.getState(fixture.connectionId))?.cursor).toMatchObject({
    scan: { nextPage: 1, verifiedCount: 0 },
  });
  for (let i = 0; i < 3; i++) {
    await source.savePage(fixture.connectionId, i + 1, {
      events: pages[i] ?? [],
      nextPage: i === 2 ? null : i + 2,
    });
  }
  await source.finalizeNextChunk(fixture.connectionId);
  for (let i = 0; i < 6; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({ status: 'COMPLETE' });
  const baseline = await source.prepareBaseline(fixture.connectionId, 'head-100');
  expect(baseline.boundary?.sourceOrder).toBe(0);
  // Legacy replay must reproduce the same discarded observation and eventual proof.
  await db.prisma.agentSourceCheckpoint.deleteMany();
  for (let i = 0; i < 18; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({ status: 'COMPLETE' });
  expect(await source.getBaseline(fixture.connectionId, baseline.id)).toEqual(baseline);
  expect(await db.prisma.agentSourcePage.count()).toBe(1);
});

it('retains malformed legacy proof that resumes capture after verification started', async () => {
  await db.prisma.agentSourceState.deleteMany();
  await source.prepareBaseline(fixture.connectionId, 'anchor');
  await db.prisma.agentSourcePage.createMany({
    data: [
      {
        connectionId: fixture.connectionId,
        scanId: 'bad-phase',
        ordinal: 0,
        phase: 'CAPTURE',
        requestPage: 1,
        nextPage: 2,
        evidence: {
          ids: ['head', 'anchor'],
          entries: [{ providerEventId: 'head', eventId: null }],
        },
      },
      {
        connectionId: fixture.connectionId,
        scanId: 'bad-phase',
        ordinal: 1,
        phase: 'VERIFY',
        requestPage: 1,
        nextPage: 2,
        evidence: { ids: ['head'], entries: [] },
      },
      {
        connectionId: fixture.connectionId,
        scanId: 'bad-phase',
        ordinal: 2,
        phase: 'CAPTURE',
        requestPage: 2,
        evidence: { ids: ['tail'], entries: [{ providerEventId: 'tail', eventId: null }] },
      },
      {
        connectionId: fixture.connectionId,
        scanId: 'bad-phase',
        ordinal: 3,
        phase: 'VERIFY',
        requestPage: 2,
        evidence: { ids: ['tail', 'anchor'], entries: [] },
      },
      {
        connectionId: fixture.connectionId,
        scanId: 'bad-phase',
        ordinal: 4,
        phase: 'FINALIZED',
        requestPage: 2,
        sourceOrder: 0,
        evidence: { ids: ['head'], entries: [] },
      },
    ],
  });
  for (let i = 0; i < 7; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({ status: 'INVALID' });
  expect(await db.prisma.agentSourcePage.count()).toBe(5);
});

it('replays partial pre-upgrade checkpoints without deleting heads or fencing an active scan', async () => {
  await db.prisma.agentSourceState.deleteMany();
  const anchor = await source.prepareBaseline(fixture.connectionId, 'anchor');
  const ids = Array.from({ length: 105 }, (_, i) => ({
    providerEventId: `head-${i}`,
    payload: null,
  }));
  const first = ids.slice(0, 100);
  const tail = [...ids.slice(100), { providerEventId: 'anchor', payload: null }];
  await source.savePage(fixture.connectionId, 1, { events: first, nextPage: 2 });
  await source.savePage(fixture.connectionId, 2, { events: tail, nextPage: null });
  await source.savePage(fixture.connectionId, 1, { events: first, nextPage: 2 });
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({
    nextOrdinal: 3,
    verifiedCount: 100,
  });
  const pages = await db.prisma.agentSourcePage.findMany();
  const heads = await db.prisma.agentSourceHead.findMany();
  // Recreate the pre-upgrade shape, then apply the actual additive migration SQL.
  const sqlite = new Database(db.databasePath);
  try {
    sqlite.exec('ALTER TABLE "AgentSourceCheckpoint" DROP COLUMN "verification"');
    sqlite.exec(
      readFileSync(
        join(
          process.cwd(),
          'prisma/migrations/20261102174500_source_checkpoint_verifier_progress/migration.sql'
        ),
        'utf8'
      )
    );
  } finally {
    sqlite.close();
  }
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({
    nextOrdinal: 0,
    entryCount: 0,
    executableCount: 0,
    verifiedCount: 0,
    verification: null,
  });
  expect(await db.prisma.agentSourcePage.findMany()).toEqual(pages);
  expect(await db.prisma.agentSourceHead.findMany()).toEqual(heads);
  await source.savePage(fixture.connectionId, 2, { events: tail, nextPage: null });
  await source.finalizeNextChunk(fixture.connectionId);
  for (let i = 0; i < 8; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({ status: 'COMPLETE' });
  expect(await source.getBaseline(fixture.connectionId, anchor.id)).toEqual(anchor);
  expect(
    (await source.prepareBaseline(fixture.connectionId, 'head-104')).boundary?.sourceOrder
  ).toBe(0);
});
