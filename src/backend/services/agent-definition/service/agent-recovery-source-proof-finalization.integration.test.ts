import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import { createLedgerFixture } from '@/backend/services/agent-definition/resources/testing/agent-ledger.test-support';
import { configService } from '@/backend/services/config.service';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { agentGithubCursorSchema } from '@/shared/agent-source-state';
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
let accessor: typeof import('@/backend/services/agent-definition/resources/agent-source.accessor').agentSourceAccessor;
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
beforeEach(async () => {
  db = await createIntegrationDatabase();
  process.env.BASE_DIR = db.tempDir;
  database.prisma = db.prisma;
  vi.spyOn(configService, 'getBaseDir').mockReturnValue(db.tempDir);
  const runtime = await vi.importActual<typeof import('@/backend/services/agent-definition')>(
    '@/backend/services/agent-definition'
  );
  accessor = (
    await vi.importActual<
      typeof import('@/backend/services/agent-definition/resources/agent-source.accessor')
    >('@/backend/services/agent-definition/resources/agent-source.accessor')
  ).agentSourceAccessor;
  fixture = await createLedgerFixture(db, runtime);
}, 30_000);
afterEach(async () => {
  await destroyIntegrationDatabase(db);
});
async function captured() {
  await accessor.prepareBaseline(fixture.connectionId, null);
  const events = [
    { providerEventId: 'A', payload: fixture.github('A').payload },
    { providerEventId: 'X', payload: null },
    { providerEventId: 'B', payload: fixture.github('B').payload },
  ];
  await accessor.savePage(fixture.connectionId, 1, { events, nextPage: null });
  await accessor.savePage(fixture.connectionId, 1, { events, nextPage: null });
}
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
async function completeCheckpoint() {
  for (let tick = 0; tick < 20; tick++) {
    if ((await db.prisma.agentSourceCheckpoint.findFirst())?.status === 'COMPLETE') {
      return;
    }
    await accessor.maintainCheckpoints(fixture.connectionId);
  }
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({ status: 'COMPLETE' });
}
it('rejects a FINALIZE count that would skip an executable event with no assigned ordinal', async () => {
  await captured();
  const backup = await dataBackupService.exportData('test');
  const state = backup.data.durable!.agentSourceState[0]!;
  const cursor = agentGithubCursorSchema.parse(state.cursor);
  expect(cursor.scan?.phase).toBe('FINALIZE');
  cursor.scan!.finalizedCount = 1;
  state.lastSourceOrder = 1;
  state.cursor = cursor;
  await clear();
  const lookup = vi.spyOn(db.prisma, '$queryRaw');
  const failure: unknown = await dataBackupService.importData(backup).then(
    () => null,
    (error: unknown) => error
  );
  if (failure === null) {
    await enable();
    await accessor.finalizeNextChunk(fixture.connectionId);
    // Without preflight rejection the real finalizer commits A and loses B.
    expect
      .soft(await db.prisma.agentEvent.findFirst({ where: { providerEventId: 'B' } }))
      .toMatchObject({ sourceOrder: 1 });
  }
  expect(failure).toMatchObject({ code: 'INVALID_INPUT' });
  expect(lookup).not.toHaveBeenCalled();
  expect(await db.prisma.project.count()).toBe(0);
});
it('rejects contradictory retained VERIFY evidence on a claimed COMPLETE checkpoint before opening the private DB', async () => {
  await captured();
  await accessor.finalizeNextChunk(fixture.connectionId);
  const backup = await dataBackupService.exportData('test');
  expect(backup.data.durable!.agentSourceCheckpoint[0]!.status).toBe('COMPLETE');
  const page = backup.data.durable!.agentSourcePage.find((row) => row.phase === 'VERIFY')!;
  page.evidence = { ids: ['A', 'B', 'X'], entries: [] };
  await clear();
  const lookup = vi.spyOn(db.prisma, '$queryRaw');
  await expect(dataBackupService.importData(backup)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(lookup).not.toHaveBeenCalled();
  expect(await db.prisma.project.count()).toBe(0);
});
it('resumes a legitimately assigned partial FINALIZE prefix without dropping either executable event', async () => {
  await captured();
  const backup = await dataBackupService.exportData('test');
  const durable = backup.data.durable!;
  const state = durable.agentSourceState[0]!;
  const cursor = agentGithubCursorSchema.parse(state.cursor);
  cursor.scan!.finalizedCount = 1;
  state.lastSourceOrder = 1;
  state.cursor = cursor;
  durable.agentEvent.find((row) => row.providerEventId === 'B')!.sourceOrder = 1;
  await clear();
  await dataBackupService.importData(backup);
  await enable();
  await accessor.finalizeNextChunk(fixture.connectionId);
  expect(await db.prisma.agentEvent.findFirst({ where: { providerEventId: 'A' } })).toMatchObject({
    sourceOrder: 2,
  });
  expect(await db.prisma.agentEvent.findFirst({ where: { providerEventId: 'B' } })).toMatchObject({
    sourceOrder: 1,
  });
  expect(
    agentGithubCursorSchema.parse((await accessor.getState(fixture.connectionId))?.cursor)
  ).toMatchObject({ committedHeadEventId: 'A', scan: null });
});

it('resumes the real 1000-event finalizer chunk after public import and assigns the remaining event once', async () => {
  await accessor.prepareBaseline(fixture.connectionId, null);
  const events = Array.from({ length: 1001 }, (_, index) => ({
    providerEventId: `event-${index}`,
    payload: fixture.github(`event-${index}`).payload,
  }));
  for (let pass = 0; pass < 2; pass++) {
    for (let offset = 0; offset < events.length; offset += 100) {
      await accessor.savePage(fixture.connectionId, offset / 100 + 1, {
        events: events.slice(offset, offset + 100),
        nextPage: offset + 100 < events.length ? offset / 100 + 2 : null,
      });
    }
  }
  await accessor.finalizeNextChunk(fixture.connectionId);
  const before = await accessor.getState(fixture.connectionId);
  expect(before?.lastSourceOrder).toBe(1000);
  expect(agentGithubCursorSchema.parse(before?.cursor).scan).toMatchObject({
    phase: 'FINALIZE',
    finalizedCount: 1000,
  });
  const backup = await dataBackupService.exportData('test');
  await clear();
  await dataBackupService.importData(backup);
  await enable();
  expect(await accessor.finalizeNextChunk(fixture.connectionId)).toHaveLength(1);
  expect(await db.prisma.agentEvent.count({ where: { sourceOrder: { not: null } } })).toBe(1001);
  expect(
    await db.prisma.agentEvent.findFirst({ where: { providerEventId: 'event-1000' } })
  ).toMatchObject({ sourceOrder: 1 });
  expect(
    await db.prisma.agentEvent.findFirst({ where: { providerEventId: 'event-0' } })
  ).toMatchObject({ sourceOrder: 1001 });
  expect(
    agentGithubCursorSchema.parse((await accessor.getState(fixture.connectionId))?.cursor)
  ).toMatchObject({ committedHeadEventId: 'event-0', scan: null });
});

it.each(['retained', 'compacted-prefix'] as const)(
  'preserves canonical COMPLETE verification with %s pages and repeated overlap reads',
  async (mode) => {
    await accessor.prepareBaseline(fixture.connectionId, null);
    const events = Array.from({ length: 101 }, (_, index) => ({
      providerEventId: `control-${index}`,
      payload: null,
    }));
    const first = { events: events.slice(0, 100), nextPage: 2 };
    const tail = { events: events.slice(100), nextPage: null };
    await accessor.savePage(fixture.connectionId, 1, first);
    await accessor.savePage(fixture.connectionId, 2, tail);
    for (let repeat = 0; repeat < 104; repeat++) {
      await accessor.resume(fixture.connectionId);
      await accessor.savePage(fixture.connectionId, 1, first);
    }
    await accessor.savePage(fixture.connectionId, 2, tail);
    await accessor.finalizeNextChunk(fixture.connectionId);
    await completeCheckpoint();
    if (mode === 'compacted-prefix') {
      expect(await accessor.maintainCheckpoints(fixture.connectionId)).toMatchObject({
        deletedPages: 100,
      });
      expect(await db.prisma.agentSourcePage.count({ where: { phase: 'CAPTURE' } })).toBe(0);
    }
    const backup = await dataBackupService.exportData('test');
    await clear();
    await dataBackupService.importData(backup);
    await enable();
    expect(
      (await accessor.prepareBaseline(fixture.connectionId, 'control-100')).boundary?.sourceOrder
    ).toBe(0);
    expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({ status: 'COMPLETE' });
  }
);

it('preserves a COMPLETE checkpoint whose canonical replay discards a shifted verification overlap', async () => {
  await accessor.prepareBaseline(fixture.connectionId, null);
  const events = Array.from({ length: 201 }, (_, index) => ({
    providerEventId: `control-${index}`,
    payload: null,
  }));
  const pages = [
    { events: events.slice(0, 100), nextPage: 2 },
    { events: events.slice(100, 200), nextPage: 3 },
    { events: events.slice(200), nextPage: null },
  ];
  for (const [index, page] of pages.entries()) {
    await accessor.savePage(fixture.connectionId, index + 1, page);
  }
  await accessor.savePage(fixture.connectionId, 1, pages[0]!);
  await accessor.savePage(fixture.connectionId, 2, pages[1]!);
  await accessor.resume(fixture.connectionId);
  await accessor.savePage(fixture.connectionId, 2, {
    events: [{ providerEventId: 'inserted-prefix', payload: null }, ...events.slice(99, 198)],
    nextPage: 3,
  });
  expect(
    agentGithubCursorSchema.parse((await accessor.getState(fixture.connectionId))?.cursor).scan
  ).toMatchObject({ verifiedCount: 0, nextPage: 1 });
  for (const [index, page] of pages.entries()) {
    await accessor.savePage(fixture.connectionId, index + 1, page);
  }
  await accessor.finalizeNextChunk(fixture.connectionId);
  await completeCheckpoint();
  const backup = await dataBackupService.exportData('test');
  await clear();
  await dataBackupService.importData(backup);
  await enable();
  expect(
    (await accessor.prepareBaseline(fixture.connectionId, 'control-100')).boundary?.sourceOrder
  ).toBe(0);
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({ status: 'COMPLETE' });
});
