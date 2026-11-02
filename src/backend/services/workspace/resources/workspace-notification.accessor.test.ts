import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TunedPrismaBetterSqlite3 } from '@/backend/lib/sqlite-adapter';
import { runMigrations } from '@/backend/migrate';
import { PrismaClient } from '@prisma-gen/client';

const state = vi.hoisted(() => ({ client: null as PrismaClient | null }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return state.client;
  },
}));
import { workspaceNotificationAccessor as mail } from './workspace-notification.accessor';

const dir = mkdtempSync(join(tmpdir(), 'ff-mail-'));
const databasePath = join(dir, 'mail.db');
let serial = 0;
async function workspace() {
  const id = `mail-${++serial}`;
  await state.client!.workspace.create({ data: { id, name: id, projectId: 'mail-project' } });
  return id;
}
function send(workspaceId: string, message = 'hello', extra = {}) {
  return mail.create({
    workspaceId,
    sourceWorkspaceId: 'sender',
    sourceWorkspaceName: 'Sender',
    sourceProjectName: 'Project',
    message,
    ...extra,
  });
}

beforeAll(async () => {
  runMigrations({
    databasePath,
    migrationsPath: join(process.cwd(), 'prisma/migrations'),
    log: () => undefined,
  });
  state.client = new PrismaClient({ adapter: new TunedPrismaBetterSqlite3({ url: databasePath }) });
  await state.client.project.create({
    data: {
      id: 'mail-project',
      name: 'Mail',
      slug: 'mail',
      repoPath: '/tmp/repo',
      worktreeBasePath: '/tmp/work',
    },
  });
});
afterAll(async () => {
  await state.client?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe('durable workspace mailbox', () => {
  it('bounds summaries and pages by monotonic revision without returning bodies', async () => {
    const id = await workspace();
    for (let n = 0; n < 23; n++) {
      await send(id, 'x'.repeat(500));
    }
    const first = await mail.listMail({ workspaceId: id });
    expect(first.items).toHaveLength(20);
    expect(first.revision).toBe(23);
    expect(first.items[0]).toMatchObject({
      revision: 23,
      kind: 'MESSAGE',
      preview: 'x'.repeat(160),
    });
    expect(first.items[0]).not.toHaveProperty('message');
    expect(first.items[0]).not.toHaveProperty('body');
    const second = await mail.listMail({ workspaceId: id, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.revision)).toEqual([3, 2, 1]);
    expect(second.nextCursor).toBeNull();
  });
  it('budgets selected bodies in total, supports offsets, and scopes every ID', async () => {
    const id = await workspace();
    const other = await workspace();
    const a = await send(id, 'a'.repeat(10_000));
    const b = await send(id, 'b'.repeat(10_000));
    const foreign = await send(other);
    const read = await mail.readMail({
      workspaceId: id,
      ids: [a.id, b.id, foreign.id],
      maxChars: 12_000,
    });
    expect(read.items).toHaveLength(2);
    expect(read.items.map((item) => item.body.length)).toEqual([10_000, 2000]);
    expect(read.items[1]?.nextOffset).toBe(2000);
    expect(
      (await mail.readMail({ workspaceId: id, ids: [b.id], offset: 2000 })).items[0]?.body
    ).toBe('b'.repeat(8000));
    expect((await mail.listMail({ workspaceId: other })).items[0]?.readAt).toBeNull();
  });
  it('bounds migrated Unicode previews using the same character budget as the API', async () => {
    const id = await workspace();
    const sent = await send(id, '😀'.repeat(200));
    await state.client!.workspaceNotification.update({
      where: { id: sent.id },
      data: { preview: '😀'.repeat(160) },
    });
    expect((await mail.listMail({ workspaceId: id })).items[0]?.preview.length).toBe(160);
    expect(
      (await mail.readMail({ workspaceId: id, ids: [sent.id] })).items[0]?.preview.length
    ).toBe(160);
  });
  it('does not mark budget-exhausted entries read and resumes without skipping text', async () => {
    const id = await workspace();
    const a = await send(id, 'abc');
    const b = await send(id, 'def');
    const read = await mail.readMail({ workspaceId: id, ids: [a.id, b.id], maxChars: 3 });
    expect(read.items[1]).toMatchObject({ body: '', offset: 0, nextOffset: 0, readAt: null });
    expect(
      (await mail.listMail({ workspaceId: id, unreadOnly: true })).items.map((row) => row.id)
    ).toEqual([b.id]);
    expect(
      (await mail.readMail({ workspaceId: id, ids: [b.id], offset: read.items[1]!.nextOffset! }))
        .items[0]?.body
    ).toBe('def');
  });
  it('keeps newer arrivals pending after stale/scoped acknowledgement and a settled wake', async () => {
    const id = await workspace();
    const other = await workspace();
    const first = await send(id);
    const foreign = await send(other);
    const wake = await mail.claimWake({ workspaceId: id });
    expect(wake).not.toBeNull();
    expect(await mail.claimWake({ workspaceId: id })).toBeNull();
    expect(await mail.settleWake(wake!)).toBe(true);
    const newer = await send(id);
    expect(await mail.claimWake({ workspaceId: id })).toBeNull();
    expect(
      await mail.ackMail({
        workspaceId: id,
        ids: [first.id, newer.id, foreign.id],
        throughRevision: 1,
      })
    ).toMatchObject({ acknowledged: 1 });
    const next = await mail.claimWake({ workspaceId: id });
    expect(next?.revision).toBe(2);
    expect(
      (await mail.listMail({ workspaceId: id, unreadOnly: true })).items.map((item) => item.id)
    ).toEqual([newer.id]);
    expect((await mail.listMail({ workspaceId: other })).items[0]?.acknowledgedAt).toBeNull();
  });
  it('supersedes only keyed progress from the same sender and never wakes for quiet updates', async () => {
    const id = await workspace();
    await send(id, 'old', { kind: 'PROGRESS', taskKey: 'task' });
    await send(id, 'different sender', {
      kind: 'PROGRESS',
      taskKey: 'task',
      sourceWorkspaceId: 'another',
    });
    await send(id, 'question', { kind: 'QUESTION', taskKey: 'task' });
    for (let n = 0; n < 1000; n++) {
      await send(id, String(n), { kind: 'PROGRESS', taskKey: 'task' });
    }
    const active = await mail.listMail({ workspaceId: id, unreadOnly: true, kinds: ['PROGRESS'] });
    expect(active.items).toHaveLength(2);
    expect((await mail.listMail({ workspaceId: id })).items).toHaveLength(3);
    expect(
      (await mail.listMail({ workspaceId: id, includeSuperseded: true })).nextCursor
    ).not.toBeNull();
    const wake = await mail.claimWake({ workspaceId: id });
    expect(wake).not.toBeNull();
    const quiet = await workspace();
    await send(quiet, 'quiet', { kind: 'PROGRESS' });
    expect(await mail.claimWake({ workspaceId: quiet })).toBeNull();
  }, 30_000);
  it('keeps the highest task revision active when progress arrives out of order', async () => {
    const id = await workspace();
    const latest = await send(id, 'latest', {
      kind: 'PROGRESS',
      taskKey: 'versioned',
      taskRevision: 3,
    });
    const stale = await send(id, 'late', {
      kind: 'PROGRESS',
      taskKey: 'versioned',
      taskRevision: 2,
    });
    expect(
      (await mail.listMail({ workspaceId: id, unreadOnly: true })).items.map((row) => row.id)
    ).toEqual([latest.id]);
    expect(
      (await mail.listMail({ workspaceId: id, includeSuperseded: true })).items.find(
        (row) => row.id === stale.id
      )?.supersededAt
    ).toBeInstanceOf(Date);
  });
  it('selective ACK releases the latch for new mail without waking for untouched old mail', async () => {
    const id = await workspace();
    const first = await send(id);
    await send(id, 'uninspected');
    const wake = await mail.claimWake({ workspaceId: id });
    await mail.settleWake(wake!);
    await mail.ackMail({ workspaceId: id, ids: [first.id], throughRevision: 2 });
    expect(await mail.claimWake({ workspaceId: id })).toBeNull();
    await send(id, 'new blocker', { kind: 'BLOCKER' });
    expect((await mail.claimWake({ workspaceId: id }))?.revision).toBe(3);
  });
  it('keeps an observation fence when ACK precedes queued wake delivery', async () => {
    const id = await workspace();
    const first = await send(id);
    const wake = await mail.claimWake({ workspaceId: id });
    await mail.ackMail({ workspaceId: id, ids: [first.id], throughRevision: 1 });
    await send(id, 'new');
    await mail.settleWake(wake!);
    expect((await mail.claimWake({ workspaceId: id }))?.revision).toBe(2);
  });
  it('returns a retry deadline for crashed claims and fences stale settlement after expiry', async () => {
    const id = await workspace();
    await send(id);
    const stale = await mail.claimWake({ workspaceId: id });
    expect(await mail.nextWakeRetryAt({ workspaceId: id })).toBeInstanceOf(Date);
    await state.client!.workspaceMailState.update({
      where: { workspaceId: id },
      data: { claimedAt: new Date(Date.now() - 31_000) },
    });
    const retry = await mail.claimWake({ workspaceId: id });
    expect(retry?.claimId).not.toBe(stale?.claimId);
    expect(await mail.settleWake(stale!)).toBe(false);
    expect(await mail.settleWake(retry!)).toBe(true);
    expect(await mail.nextWakeRetryAt({ workspaceId: id })).toBeNull();
  });
  it('serializes concurrent sends and wake claims and retries released claims safely', async () => {
    const id = await workspace();
    const sent = await Promise.all(Array.from({ length: 8 }, () => send(id)));
    expect(new Set(sent.map((row) => row.revision)).size).toBe(8);
    const claims = (
      await Promise.all(Array.from({ length: 8 }, () => mail.claimWake({ workspaceId: id })))
    ).filter(Boolean);
    expect(claims).toHaveLength(1);
    await mail.releaseWake(claims[0]!);
    const retry = await mail.claimWake({ workspaceId: id });
    expect(retry?.revision).toBe(8);
    expect(await mail.settleWake(claims[0]!)).toBe(false);
    expect(await mail.settleWake(retry!)).toBe(true);
  });
});

it('uses the highest actionable revision for wakes and permits scoped idempotent ACK repair', async () => {
  const id = await workspace();
  const first = await send(id, 'actionable');
  await send(id, 'quiet', { kind: 'PROGRESS' });
  const wake = await mail.claimWake({ workspaceId: id });
  expect(wake?.revision).toBe(first.revision);
  await mail.settleWake(wake!);
  await mail.ackMail({ workspaceId: id, ids: [first.id], throughRevision: 1 });
  // Legacy state may have settled a wake including a later quiet revision.
  await state.client!.workspaceMailState.update({
    where: { workspaceId: id },
    data: { notifiedRevision: 2 },
  });
  await send(id, 'new actionable');
  expect(await mail.claimWake({ workspaceId: id })).toBeNull();
  expect(
    await mail.ackMail({ workspaceId: id, ids: [first.id], throughRevision: 2 })
  ).toMatchObject({ acknowledged: 0 });
  expect((await mail.claimWake({ workspaceId: id }))?.revision).toBe(3);
});

it('durably quarantines ambiguous wake claims across expiry until explicit retry', async () => {
  const id = await workspace();
  await send(id);
  const wake = (await mail.claimWake({ workspaceId: id }))!;
  expect(await mail.quarantineWake(wake)).toBe(true);
  expect(await mail.disarmWake({ ...wake, claimId: 'stale-attempt' })).toBe(false);
  expect(await mail.disarmWake(wake)).toBe(true);
  expect((await mail.listMail({ workspaceId: id })).wakeAmbiguous).toBe(false);
  expect(await mail.quarantineWake(wake)).toBe(true);
  await state.client!.workspaceMailState.update({
    where: { workspaceId: id },
    data: { claimedAt: new Date(Date.now() - 31_000) },
  });
  expect(await mail.claimWake({ workspaceId: id })).toBeNull();
  expect(await mail.nextWakeRetryAt({ workspaceId: id })).toBeNull();
  expect((await mail.listMail({ workspaceId: id })).wakeAmbiguous).toBe(true);
  expect(await mail.retryWake({ workspaceId: id })).toBe(true);
  const retry = (await mail.claimWake({ workspaceId: id }))!;
  expect(retry.claimId).not.toBe(wake.claimId);
  expect(await mail.settleWake(wake)).toBe(false);
  expect(await mail.quarantineWake(wake)).toBe(false);
  expect(await mail.settleWake(retry)).toBe(true);
  expect((await mail.listMail({ workspaceId: id })).wakeAmbiguous).toBe(false);
});

it('settles a late provider receipt only while its exact ambiguous wake still owns the claim', async () => {
  const id = await workspace();
  await send(id);
  const wake = (await mail.claimWake({ workspaceId: id }))!;
  await mail.quarantineWake(wake);
  expect(await mail.settleWake(wake)).toBe(true);
  expect(await mail.retryWake({ workspaceId: id })).toBe(false);
  expect((await mail.listMail({ workspaceId: id })).wakeAmbiguous).toBe(false);
});
