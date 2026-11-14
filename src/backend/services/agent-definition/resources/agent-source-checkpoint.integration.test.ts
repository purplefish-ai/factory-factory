import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { agentSourcePageEvidenceSchema } from '@/shared/agent-source-state';
import { createLedgerFixture } from './testing/agent-ledger.test-support';

let db: IntegrationDatabase;
let source: typeof import('./agent-source.accessor').agentSourceAccessor;
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
let initialBaselineId: string;
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
  initialBaselineId = (await source.prepareBaseline(fixture.connectionId, null)).id;
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

it('compacts only equivalent finalized pages and preserves every head ordinal and issued baseline ID', async () => {
  const pending = await interval();
  const answer = await source.getBaseline(fixture.connectionId, pending.id);
  expect(answer?.boundary?.sourceOrder).toBe(1);
  const before = await source.getState(fixture.connectionId);
  for (let i = 0; i < 6; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
  expect(await db.prisma.agentSourcePage.count({ where: { phase: { not: 'FINALIZED' } } })).toBe(0);
  expect(await source.getBaseline(fixture.connectionId, pending.id)).toEqual(answer);
  expect(await source.getBaseline(fixture.connectionId, initialBaselineId)).toEqual({
    id: initialBaselineId,
    boundary: { provider: 'GITHUB', headEventId: null, sourceOrder: 0 },
  });
  expect(await source.getState(fixture.connectionId)).toEqual(before);
  for (const [head, order] of [
    ['unsupported-new', 2],
    ['label-new', 2],
    ['unsupported-middle', 1],
    ['label-old', 1],
    ['unsupported-old', 0],
  ] as const) {
    expect((await source.prepareBaseline(fixture.connectionId, head)).boundary?.sourceOrder).toBe(
      order
    );
  }
});

it('retains a delayed provider read with no baseline pin through compaction and event pruning', async () => {
  await interval();
  await db.prisma.agentEvent.deleteMany();
  for (let i = 0; i < 6; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
  // The provider observed this unsupported head before prepareBaseline persisted a pin.
  expect(
    await db.prisma.agentSourceBaseline.count({ where: { headEventId: 'unsupported-old' } })
  ).toBe(0);
  expect((await source.prepareBaseline(fixture.connectionId, 'unsupported-old')).boundary).toEqual({
    provider: 'GITHUB',
    headEventId: 'unsupported-old',
    sourceOrder: 0,
  });
});

it('publishes all new captured head checkpoints atomically with interval finalization', async () => {
  await interval();
  expect(await db.prisma.agentSourceHead.count()).toBe(5);
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({
    status: 'COMPLETE',
    sourceOrder: 2,
    entryCount: 5,
    executableCount: 2,
  });
});

it('backfills legacy proof one page at a time with fallback until a verified index is complete', async () => {
  await interval();
  await db.prisma.agentSourceCheckpoint.deleteMany();
  const original = await db.prisma.agentSourcePage.findMany();
  expect(await source.maintainCheckpoints(fixture.connectionId)).toEqual({
    indexedPages: 1,
    deletedPages: 0,
  });
  expect(await db.prisma.agentSourcePage.findMany()).toEqual(original);
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({ status: 'BUILDING' });
  expect(
    (await source.prepareBaseline(fixture.connectionId, 'unsupported-old')).boundary?.sourceOrder
  ).toBe(0);
  await Promise.all([
    source.maintainCheckpoints(fixture.connectionId),
    source.maintainCheckpoints(fixture.connectionId),
  ]);
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({ status: 'COMPLETE' });
  await source.maintainCheckpoints(fixture.connectionId);
  expect(await db.prisma.agentSourcePage.count()).toBe(1);
});

it.each(['malformed', 'missing-page', 'wrong-highwater', 'incomplete-verification'])(
  'retains legacy pages when proof is %s',
  async (corruption) => {
    await interval();
    await db.prisma.agentSourceCheckpoint.deleteMany();
    if (corruption === 'malformed') {
      await db.prisma.agentSourcePage.updateMany({
        where: { phase: 'CAPTURE' },
        data: { evidence: {} },
      });
    } else if (corruption === 'missing-page') {
      await db.prisma.agentSourcePage.deleteMany({ where: { ordinal: 0 } });
    } else if (corruption === 'wrong-highwater') {
      await db.prisma.agentSourcePage.updateMany({
        where: { phase: 'FINALIZED' },
        data: { sourceOrder: 0 },
      });
    } else {
      await db.prisma.agentSourcePage.updateMany({
        where: { phase: 'VERIFY' },
        data: { evidence: { ids: [], entries: [] } },
      });
    }
    const pages = await db.prisma.agentSourcePage.findMany();
    for (let i = 0; i < 5; i++) {
      await source.maintainCheckpoints(fixture.connectionId);
    }
    expect(await db.prisma.agentSourcePage.findMany()).toEqual(pages);
    expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({ status: 'INVALID' });
  }
);

it('never compacts an active scan, and finalization races safely with backfill', async () => {
  await interval();
  await db.prisma.agentSourceCheckpoint.deleteMany();
  const events = [
    { providerEventId: 'next-control', payload: null },
    { providerEventId: 'unsupported-new', payload: null },
  ];
  await source.savePage(fixture.connectionId, 1, { events, nextPage: null });
  const activePages = await db.prisma.agentSourcePage.findMany({ where: { phase: 'CAPTURE' } });
  await source.savePage(fixture.connectionId, 1, { events, nextPage: null });
  await Promise.all([
    source.maintainCheckpoints(fixture.connectionId),
    source.finalizeNextChunk(fixture.connectionId),
  ]);
  expect((await source.getState(fixture.connectionId))?.cursor).toMatchObject({
    scan: null,
    committedHeadEventId: 'next-control',
  });
  expect(
    await db.prisma.agentSourcePage.count({
      where: { id: { in: activePages.map((page) => page.id) } },
    })
  ).toBe(activePages.length);
  for (let i = 0; i < 6; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
  expect(
    (await source.prepareBaseline(fixture.connectionId, 'unsupported-old')).boundary?.sourceOrder
  ).toBe(0);
  expect(
    (await source.prepareBaseline(fixture.connectionId, 'next-control')).boundary?.sourceOrder
  ).toBe(2);
});

it('bounds backfill to100 heads per call and uses indexed lookups after page compaction', async () => {
  const events = Array.from({ length: 250 }, (_, i) => ({
    providerEventId: `control-${i}`,
    payload: null,
  }));
  for (let page = 1; page <= 3; page++) {
    await source.savePage(fixture.connectionId, page, {
      events: events.slice((page - 1) * 100, page * 100),
      nextPage: page === 3 ? null : page + 1,
    });
  }
  for (let page = 1; page <= 3; page++) {
    await source.savePage(fixture.connectionId, page, {
      events: events.slice((page - 1) * 100, page * 100),
      nextPage: page === 3 ? null : page + 1,
    });
  }
  await source.finalizeNextChunk(fixture.connectionId);
  await db.prisma.agentSourceCheckpoint.deleteMany();
  for (const count of [100, 200, 250]) {
    expect(await source.maintainCheckpoints(fixture.connectionId)).toEqual({
      indexedPages: 1,
      deletedPages: 0,
    });
    expect(await db.prisma.agentSourceHead.count()).toBe(count);
  }
  // Verification/finalization plus eight bounded authority chunks and compaction.
  for (let i = 0; i < 12; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
  expect(await db.prisma.agentSourcePage.count()).toBe(1);
  const { historicalHeadOrder, sourceEpoch } =
    await vi.importActual<typeof import('./agent-source-queries')>('./agent-source-queries');
  await db.prisma.$transaction(async (tx) => {
    const raw = vi.spyOn(tx, '$queryRaw');
    const pages = vi.spyOn(tx.agentSourcePage, 'findMany');
    const heads = vi.spyOn(tx.agentSourceHead, 'findFirst');
    expect(
      await historicalHeadOrder(tx, sourceEpoch(fixture.connectionId, null), 'control-249')
    ).toBe(0);
    expect(heads).toHaveBeenCalledTimes(1);
    expect(raw).not.toHaveBeenCalled();
    expect(pages).not.toHaveBeenCalled();
  });
});

it('rejects a backfill ordinal that conflicts with an already issued baseline', async () => {
  await interval();
  await db.prisma.agentSourceCheckpoint.deleteMany();
  await db.prisma.agentSourcePage.updateMany({
    where: { phase: 'FINALIZED' },
    data: { sourceOrder: 3 },
  });
  const pages = await db.prisma.agentSourcePage.findMany();
  for (let i = 0; i < 5; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({ status: 'INVALID' });
  expect(await db.prisma.agentSourcePage.findMany()).toEqual(pages);
});

it('answers a historical head from legacy proof, never from an unvalidated checkpoint', async () => {
  await interval();
  await db.prisma.agentSourceCheckpoint.deleteMany();
  await db.prisma.agentSourceCheckpoint.create({
    data: {
      connectionId: fixture.connectionId,
      scanId: 'unvalidated',
      status: 'INDEXED',
      sourceOrder: 7,
      heads: {
        create: { providerEventId: 'unsupported-old', position: 0, precedingEventCount: 0 },
      },
    },
  });
  expect((await source.prepareBaseline(fixture.connectionId, 'unsupported-old')).boundary).toEqual({
    provider: 'GITHUB',
    headEventId: 'unsupported-old',
    sourceOrder: 0,
  });
});

it('fences the source when a baseline and legacy proof disagree on a head ordinal', async () => {
  await interval();
  await db.prisma.agentSourceCheckpoint.deleteMany();
  // Legacy proof orders this head at 0; an issued baseline says 1.
  await db.prisma.agentSourceBaseline.create({
    data: { connectionId: fixture.connectionId, headEventId: 'unsupported-old', sourceOrder: 1 },
  });
  const runtime = await vi.importActual<typeof import('../index')>('../index');
  const poll = new runtime.AgentSourcePollService(
    {
      getRepositoryIdentity: () => Promise.resolve({ id: 'repo-1', name: 'org/repo' }),
      listIssueEvents: () =>
        Promise.resolve({
          events: [{ providerEventId: 'unsupported-old', payload: null }],
          nextPage: null,
        }),
      classifyError: () => 'unknown',
    },
    () => 10
  );
  await expect(
    poll.prepareBaseline(fixture.connectionId, new AbortController().signal)
  ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(await source.getState(fixture.connectionId)).toMatchObject({
    isReady: false,
    health: { state: 'RECOVERY_REQUIRED', reasonCode: 'GITHUB_CONTINUITY_LOST' },
  });
});

it('bounds compaction to100 pages', async () => {
  const ids = Array.from({ length: 100 }, (_, i) => `control-${i}`);
  await db.prisma.agentSourcePage.createMany({
    data: [
      {
        connectionId: fixture.connectionId,
        scanId: 'z-valid',
        ordinal: 0,
        phase: 'CAPTURE',
        requestPage: 1,
        nextPage: 2,
        evidence: {
          ids,
          entries: ids.map((providerEventId) => ({ providerEventId, eventId: null })),
        },
      },
      {
        connectionId: fixture.connectionId,
        scanId: 'z-valid',
        ordinal: 1,
        phase: 'CAPTURE',
        requestPage: 2,
        evidence: { ids: ['tail'], entries: [{ providerEventId: 'tail', eventId: null }] },
      },
      ...Array.from({ length: 104 }, (_, i) => ({
        connectionId: fixture.connectionId,
        scanId: 'z-valid',
        ordinal: i + 2,
        phase: 'VERIFY',
        requestPage: 1,
        nextPage: 2,
        evidence: { ids, entries: [] },
      })),
      {
        connectionId: fixture.connectionId,
        scanId: 'z-valid',
        ordinal: 106,
        phase: 'VERIFY',
        requestPage: 2,
        evidence: { ids: ['tail'], entries: [] },
      },
      {
        connectionId: fixture.connectionId,
        scanId: 'z-valid',
        ordinal: 107,
        phase: 'FINALIZED',
        requestPage: 2,
        sourceOrder: 0,
        evidence: { ids: ['control-0'], entries: [] },
      },
    ],
  });
  for (let i = 0; i < 111; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
  expect(await source.maintainCheckpoints(fixture.connectionId)).toEqual({
    indexedPages: 0,
    deletedPages: 100,
  });
  expect(await source.maintainCheckpoints(fixture.connectionId)).toEqual({
    indexedPages: 0,
    deletedPages: 7,
  });
  expect((await source.prepareBaseline(fixture.connectionId, 'tail')).boundary?.sourceOrder).toBe(
    0
  );
}, 30_000);

it('retains legacy proof when the previous committed boundary is missing from verification', async () => {
  // Start a separate source at an actual nonempty initial anchor.
  await db.prisma.agentSourceState.deleteMany();
  await source.prepareBaseline(fixture.connectionId, 'anchor');
  const events = [
    { providerEventId: 'new', payload: null },
    { providerEventId: 'anchor', payload: null },
  ];
  await source.savePage(fixture.connectionId, 1, { events, nextPage: null });
  await source.savePage(fixture.connectionId, 1, { events, nextPage: null });
  await source.finalizeNextChunk(fixture.connectionId);
  await db.prisma.agentSourceCheckpoint.deleteMany();
  await db.prisma.agentSourcePage.updateMany({
    where: { phase: 'VERIFY' },
    data: { evidence: { ids: ['new'], entries: [] } },
  });
  const pages = await db.prisma.agentSourcePage.findMany();
  for (let i = 0; i < 6; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({ status: 'INVALID' });
  expect(await db.prisma.agentSourcePage.findMany()).toEqual(pages);
});

it('withholds authority until all legacy intervals can be checked for conflicting head ordinals', async () => {
  await interval();
  await db.prisma.agentSourceBaseline.deleteMany();
  await db.prisma.agentSourceCheckpoint.deleteMany();
  const original = await db.prisma.agentSourcePage.findMany();
  await db.prisma.agentSourcePage.updateMany({ data: { scanId: 'a-first' } });
  await db.prisma.agentSourcePage.createMany({
    data: original.map(({ id: _id, createdAt: _createdAt, ...page }) => ({
      ...page,
      evidence: agentSourcePageEvidenceSchema.parse(page.evidence),
      scanId: 'z-conflicting',
      sourceOrder: page.phase === 'FINALIZED' ? 3 : page.sourceOrder,
    })),
  });
  for (let i = 0; i < 3; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
  expect(
    await db.prisma.agentSourceCheckpoint.findFirst({ where: { scanId: 'a-first' } })
  ).not.toMatchObject({ status: 'COMPLETE' });
  for (let i = 0; i < 10; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
  expect(await db.prisma.agentSourcePage.count()).toBe(6);
  expect(await db.prisma.agentSourceCheckpoint.count({ where: { status: 'COMPLETE' } })).toBe(0);
  await expect(
    source.prepareBaseline(fixture.connectionId, 'unsupported-middle')
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('fails closed when an invalid legacy interval is the only witness for an unissued head', async () => {
  await interval();
  await db.prisma.agentSourceCheckpoint.deleteMany();
  await db.prisma.agentSourcePage.updateMany({
    where: { phase: 'FINALIZED' },
    data: { sourceOrder: 3 },
  });
  for (let i = 0; i < 6; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
  await expect(
    source.prepareBaseline(fixture.connectionId, 'unsupported-old')
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('checks contradictory legacy proof even when a head already has an issued baseline', async () => {
  await interval();
  await db.prisma.agentSourceCheckpoint.deleteMany();
  const pages = await db.prisma.agentSourcePage.findMany();
  await db.prisma.agentSourcePage.createMany({
    data: pages.map(({ id: _id, createdAt: _createdAt, ...page }) => ({
      ...page,
      evidence: agentSourcePageEvidenceSchema.parse(page.evidence),
      scanId: 'conflicting',
      sourceOrder: page.phase === 'FINALIZED' ? 3 : page.sourceOrder,
    })),
  });
  await expect(
    source.prepareBaseline(fixture.connectionId, 'unsupported-middle')
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('retains all connection proof when rejected legacy pages leave later heads unexamined', async () => {
  await interval();
  await db.prisma.agentSourceBaseline.deleteMany();
  await db.prisma.agentSourceCheckpoint.deleteMany();
  const capture = await db.prisma.agentSourcePage.findFirstOrThrow({ where: { phase: 'CAPTURE' } });
  await db.prisma.agentSourcePage.updateMany({ data: { scanId: 'a-valid' } });
  await db.prisma.agentSourcePage.createMany({
    data: [
      {
        connectionId: fixture.connectionId,
        scanId: 'z-rejected',
        ordinal: 0,
        phase: 'CAPTURE',
        requestPage: 1,
        evidence: {},
      },
      {
        connectionId: fixture.connectionId,
        scanId: 'z-rejected',
        ordinal: 1,
        phase: 'CAPTURE',
        requestPage: 1,
        evidence: agentSourcePageEvidenceSchema.parse(capture.evidence),
      },
      {
        connectionId: fixture.connectionId,
        scanId: 'z-rejected',
        ordinal: 2,
        phase: 'FINALIZED',
        requestPage: 1,
        sourceOrder: 3,
        evidence: { ids: ['unsupported-new'], entries: [] },
      },
    ],
  });
  for (let i = 0; i < 12; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
  expect(await db.prisma.agentSourcePage.count()).toBe(6);
  expect(await db.prisma.agentSourceCheckpoint.count({ where: { status: 'COMPLETE' } })).toBe(0);
  await expect(
    source.prepareBaseline(fixture.connectionId, 'unsupported-old')
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('backfills a previous boundary at the start of a new capture page without fencing valid proof', async () => {
  await db.prisma.agentSourceState.deleteMany();
  const anchor = await source.prepareBaseline(fixture.connectionId, 'anchor');
  const events = Array.from({ length: 100 }, (_, i) => ({
    providerEventId: `head-${i}`,
    payload: null,
  }));
  const tail = [
    { providerEventId: 'anchor', payload: null },
    { providerEventId: 'older', payload: null },
  ];
  await source.savePage(fixture.connectionId, 1, { events, nextPage: 2 });
  await source.savePage(fixture.connectionId, 2, { events: tail, nextPage: 3 });
  await source.savePage(fixture.connectionId, 1, { events, nextPage: 2 });
  await source.savePage(fixture.connectionId, 2, { events: tail, nextPage: 3 });
  await source.finalizeNextChunk(fixture.connectionId);
  await db.prisma.agentSourceCheckpoint.deleteMany();
  for (let i = 0; i < 8; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({
    status: 'COMPLETE',
    previousBoundaryEventId: 'anchor',
    initialSourceOrder: 0,
  });
  await source.maintainCheckpoints(fixture.connectionId);
  expect(await db.prisma.agentSourcePage.count()).toBe(1);
  expect(
    (await source.prepareBaseline(fixture.connectionId, 'head-99')).boundary?.sourceOrder
  ).toBe(0);
  expect(await source.getBaseline(fixture.connectionId, anchor.id)).toEqual(anchor);
});

it('applies the invalid historical-proof fence before resolving an empty head', async () => {
  await interval();
  await db.prisma.agentSourceCheckpoint.updateMany({ data: { status: 'INVALID' } });
  const { historicalHeadOrder, sourceEpoch } =
    await vi.importActual<typeof import('./agent-source-queries')>('./agent-source-queries');
  await expect(
    db.prisma.$transaction((tx) =>
      historicalHeadOrder(tx, sourceEpoch(fixture.connectionId, null), null)
    )
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});
