import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import { createLedgerFixture } from '@/backend/services/agent-definition/resources/testing/agent-ledger.test-support';
import { configService } from '@/backend/services/config.service';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { PrismaClient } from '@prisma-gen/client';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!database.prisma) {
      throw new Error('Missing test DB');
    }
    return database.prisma;
  },
}));
let db: IntegrationDatabase;
let runtime: typeof import('@/backend/services/agent-definition');
let accessor: typeof import('@/backend/services/agent-definition/resources/agent-source.accessor').agentSourceAccessor;
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
let feed: import('@/shared/agent-source').AgentIssueEventPage['events'];
let source: InstanceType<typeof runtime.AgentSourcePollService>;
const signal = new AbortController().signal;
beforeEach(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
  vi.spyOn(configService, 'getBaseDir').mockReturnValue(db.tempDir);
  runtime = await vi.importActual('@/backend/services/agent-definition');
  accessor = (
    await vi.importActual<
      typeof import('@/backend/services/agent-definition/resources/agent-source.accessor')
    >('@/backend/services/agent-definition/resources/agent-source.accessor')
  ).agentSourceAccessor;
  fixture = await createLedgerFixture(db, runtime);
  feed = [];
  source = new runtime.AgentSourcePollService(
    {
      getRepositoryIdentity: async () => ({ id: 'repo-1', name: 'org/repo' }),
      listIssueEvents: async () => ({ events: feed, nextPage: null }),
      classifyError: () => 'unknown',
    },
    () => 0
  );
}, 30_000);
afterEach(async () => {
  await destroyIntegrationDatabase(db);
});
async function clear() {
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.agentEvent.deleteMany();
  await db.prisma.agentConnection.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
}
async function enable() {
  await db.prisma.agentDefinition.updateMany({ data: { isEnabled: true } });
  await db.prisma.agentConnection.updateMany({ data: { isEnabled: true } });
  await db.prisma.agentTrigger.updateMany({ data: { isEnabled: true, activationState: 'ACTIVE' } });
}
async function interval() {
  await source.prepareBaseline(fixture.connectionId, signal);
  const events = [
    { providerEventId: 'A', payload: fixture.github('A').payload },
    { providerEventId: 'X', payload: null },
    { providerEventId: 'B', payload: fixture.github('B').payload },
  ];
  await accessor.savePage(fixture.connectionId, 1, { events, nextPage: null });
  await accessor.savePage(fixture.connectionId, 1, { events, nextPage: null });
  await accessor.finalizeNextChunk(fixture.connectionId);
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({
    status: 'COMPLETE',
    sourceOrder: 2,
  });
}
async function rejectedBeforeWrites(
  backup: Awaited<ReturnType<typeof dataBackupService.exportData>>,
  head: string,
  canonicalOrder: number
) {
  await clear();
  const failure: unknown = await dataBackupService.importData(backup).then(
    () => null,
    (error: unknown) => error
  );
  if (failure === null) {
    // Reproduce the real activation consequence if the import guard is absent.
    await enable();
    feed = [{ providerEventId: head, payload: null }];
    expect((await source.prepareBaseline(fixture.connectionId, signal)).boundary?.sourceOrder).toBe(
      canonicalOrder
    );
  }
  expect(failure).toMatchObject({ code: 'INVALID_INPUT' });
  expect(await db.prisma.project.count()).toBe(0);
  expect(await db.prisma.agentSourceState.count()).toBe(0);
}
it('rejects a checkpoint ordinal contradicted by its retained finalized capture before reenable can trust it', async () => {
  await interval();
  const backup = await dataBackupService.exportData('test');
  const head = backup.data.durable!.agentSourceHead.find((row) => row.providerEventId === 'X');
  expect(head).toBeDefined();
  head!.precedingEventCount = 0;
  await rejectedBeforeWrites(backup, 'X', 1);
});
it('rejects an idle committed cursor that would issue X10 over a retained X5 baseline', async () => {
  feed = [{ providerEventId: 'X', payload: null }];
  await source.prepareBaseline(fixture.connectionId, signal);
  const backup = await dataBackupService.exportData('test');
  backup.data.durable!.agentSourceBaseline[0]!.sourceOrder = 5;
  backup.data.durable!.agentSourceState[0]!.lastSourceOrder = 10;
  await rejectedBeforeWrites(backup, 'X', 5);
});
it.each(['retained', 'BUILDING', 'compacted'] as const)(
  'preserves valid %s source proof and canonical preparation after import',
  async (mode) => {
    await interval();
    if (mode === 'compacted') {
      await accessor.maintainCheckpoints(fixture.connectionId);
    }
    const backup = await dataBackupService.exportData('test');
    if (mode === 'BUILDING') {
      backup.data.durable!.agentSourceCheckpoint[0]!.status = 'BUILDING';
    }
    await clear();
    await dataBackupService.importData(backup);
    if (mode === 'BUILDING') {
      expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({
        status: 'BUILDING',
        nextOrdinal: 0,
        entryCount: 0,
      });
    }
    await enable();
    feed = [{ providerEventId: 'X', payload: null }];
    expect((await source.prepareBaseline(fixture.connectionId, signal)).boundary?.sourceOrder).toBe(
      1
    );
    expect(await db.prisma.agentSourceHead.count()).toBe(3);
  }
);

it('rejects a cursor highwater contradicted only by retained event authority before preparation', async () => {
  await interval();
  const backup = await dataBackupService.exportData('test');
  const durable = backup.data.durable!;
  durable.agentSourceCheckpoint = [];
  durable.agentSourceHead = [];
  durable.agentSourcePage = [];
  durable.agentSourceState[0]!.lastSourceOrder = 7;
  await rejectedBeforeWrites(backup, 'A', 2);
});

it.each(['CAPTURE', 'VERIFY'] as const)(
  'resumes a real imported %s scan after BUILDING progress resets',
  async (phase) => {
    await source.prepareBaseline(fixture.connectionId, signal);
    const first = [{ providerEventId: 'A', payload: fixture.github('A').payload }];
    const tail = [
      { providerEventId: 'X', payload: null },
      { providerEventId: 'B', payload: fixture.github('B').payload },
    ];
    await accessor.savePage(fixture.connectionId, 1, { events: first, nextPage: 2 });
    if (phase === 'VERIFY') {
      await accessor.savePage(fixture.connectionId, 2, { events: tail, nextPage: null });
    }
    const backup = await dataBackupService.exportData('test');
    await clear();
    await dataBackupService.importData(backup);
    expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({
      status: 'BUILDING',
      nextOrdinal: 0,
      entryCount: 0,
    });
    await enable();
    if (phase === 'CAPTURE') {
      await accessor.savePage(fixture.connectionId, 2, { events: tail, nextPage: null });
    }
    await accessor.savePage(fixture.connectionId, 1, { events: first, nextPage: 2 });
    await accessor.savePage(fixture.connectionId, 2, { events: tail, nextPage: null });
    await accessor.finalizeNextChunk(fixture.connectionId);
    for (let tick = 0; tick < 6; tick++) {
      await accessor.maintainCheckpoints(fixture.connectionId);
    }
    expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({
      status: 'COMPLETE',
      sourceOrder: 2,
    });
    feed = [{ providerEventId: 'X', payload: null }];
    expect((await source.prepareBaseline(fixture.connectionId, signal)).boundary?.sourceOrder).toBe(
      1
    );
  }
);

const resetCursors = [
  { label: 'SQL null', value: null, jsonNull: false },
  { label: 'JSON null', value: null, jsonNull: true },
  { label: 'false', value: false, jsonNull: false },
  { label: 'zero', value: 0, jsonNull: false },
  { label: 'empty string', value: '', jsonNull: false },
];
it.each(resetCursors)(
  'rejects $label cursor reset over retained positive ordinals',
  async ({ value, jsonNull }) => {
    await interval();
    const backup = await dataBackupService.exportData('test');
    const durable = backup.data.durable!;
    durable.agentSourceCheckpoint = [];
    durable.agentSourceHead = [];
    durable.agentSourcePage = [];
    if (jsonNull) {
      // Exercise baseline-only authority and physical JSON-null metadata as well.
      durable.agentEvent = [];
      durable.agentSourceBaseline[0]!.headEventId = 'A';
      durable.agentSourceBaseline[0]!.sourceOrder = 2;
      durable.jsonStorage.jsonNulls.push({
        model: 'AgentSourceState',
        id: fixture.connectionId,
        field: 'cursor',
      });
    }
    durable.agentSourceState[0]!.cursor = value;
    durable.agentSourceState[0]!.lastSourceOrder = 0;
    await rejectedBeforeWrites(backup, 'A', 2);
  }
);
it.each(resetCursors)(
  'retains fresh $label storage and allows zero-order initialization',
  async ({ value, jsonNull }) => {
    await source.prepareBaseline(fixture.connectionId, signal);
    const backup = await dataBackupService.exportData('test');
    const durable = backup.data.durable!;
    durable.agentSourceState[0]!.cursor = value;
    if (jsonNull) {
      durable.jsonStorage.jsonNulls.push({
        model: 'AgentSourceState',
        id: fixture.connectionId,
        field: 'cursor',
      });
    }
    await clear();
    await dataBackupService.importData(backup);
    expect((await db.prisma.agentSourceState.findFirst())?.cursor).toEqual(value);
    if (value === null) {
      expect(
        await db.prisma.$queryRaw`SELECT json_type(cursor) AS storage FROM AgentSourceState`
      ).toEqual([{ storage: jsonNull ? 'null' : null }]);
    }
    await enable();
    feed = [{ providerEventId: 'A', payload: null }];
    expect((await source.prepareBaseline(fixture.connectionId, signal)).boundary?.sourceOrder).toBe(
      0
    );
  }
);
it('retains an opaque truthy legacy cursor while runtime parsing refuses new authority', async () => {
  await interval();
  const backup = await dataBackupService.exportData('test');
  const durable = backup.data.durable!;
  durable.agentSourceCheckpoint = [];
  durable.agentSourceHead = [];
  durable.agentSourcePage = [];
  durable.agentSourceState[0]!.cursor = { legacy: 'opaque' };
  // Preserve the real interval highwater; opaque bytes do not excuse a
  // counter below retained proof, tested separately above.
  await clear();
  await dataBackupService.importData(backup);
  await enable();
  const baselines = await db.prisma.agentSourceBaseline.findMany();
  feed = [{ providerEventId: 'A', payload: null }];
  await expect(source.prepareBaseline(fixture.connectionId, signal)).rejects.toThrow(
    'baseline preparation failed'
  );
  expect(await db.prisma.agentSourceBaseline.findMany()).toEqual(baselines);
});

it('allows a fresh null cursor with zero highwater and no retained ordinal claims', async () => {
  const backup = await dataBackupService.exportData('test');
  expect(backup.data.durable!.agentSourceBaseline).toEqual([]);
  await clear();
  await dataBackupService.importData(backup);
  await enable();
  feed = [{ providerEventId: 'first-head', payload: null }];
  expect((await source.prepareBaseline(fixture.connectionId, signal)).boundary?.sourceOrder).toBe(
    0
  );
});
