import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { WorkspaceStatus } from '@prisma-gen/client';

let db: IntegrationDatabase;
let accessor: typeof import('@/backend/services/workspace/resources/workspace-archive-recovery.accessor').workspaceArchiveRecoveryAccessor;
let lease: typeof import('./archive-lease.service').workspaceArchiveLeaseService;
let staleAfterMs: number;

beforeAll(async () => {
  db = await createIntegrationDatabase();
  ({ workspaceArchiveRecoveryAccessor: accessor } = await vi.importActual<
    typeof import('@/backend/services/workspace/resources/workspace-archive-recovery.accessor')
  >('@/backend/services/workspace/resources/workspace-archive-recovery.accessor'));
  ({ workspaceArchiveLeaseService: lease, ARCHIVE_LEASE_STALE_MS: staleAfterMs } =
    await vi.importActual<typeof import('./archive-lease.service')>('./archive-lease.service'));
}, 30_000);
afterEach(async () => {
  await db.prisma.workspace.deleteMany();
  await clearIntegrationDatabase(db.prisma);
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

async function workspace(id: string, status: WorkspaceStatus, updatedAt: Date, projectId = 'p') {
  await db.prisma.project.upsert({
    where: { id: projectId },
    create: {
      id: projectId,
      name: projectId,
      slug: projectId,
      repoPath: `/repo/${projectId}`,
      worktreeBasePath: `/wt/${projectId}`,
    },
    update: {},
  });
  await db.prisma.workspace.create({ data: { id, projectId, name: id, status } });
  // Prisma sets `updatedAt` itself on create; move it to the lease time under test.
  await db.prisma.workspace.update({ where: { id }, data: { updatedAt } });
  return (await db.prisma.workspace.findUniqueOrThrow({ where: { id } })).updatedAt;
}

const readUpdatedAt = async (id: string) =>
  (await db.prisma.workspace.findUniqueOrThrow({ where: { id } })).updatedAt;

it('lets exactly one of two concurrent claims win a stale row both observed', async () => {
  const observed = await workspace('stale', 'ARCHIVING', new Date(Date.now() - 10 * 60_000));

  const claims = await Promise.all([
    lease.claim('stale', observed),
    lease.claim('stale', observed),
  ]);

  const winners = claims.filter((stamp) => stamp !== null);
  expect(winners).toHaveLength(1);
  expect(await readUpdatedAt('stale')).toEqual(winners[0]);
  expect(lease.isStale(await readUpdatedAt('stale'))).toBe(false);
});

it('refuses a claim once anyone has written the row, or once it left ARCHIVING', async () => {
  const observed = await workspace('renewed', 'ARCHIVING', new Date(Date.now() - 10 * 60_000));
  expect(await accessor.renewArchiving('renewed', new Date())).toBe(true);
  await expect(lease.claim('renewed', observed)).resolves.toBeNull();

  const failedAt = await workspace('failed', 'FAILED', new Date(Date.now() - 10 * 60_000));
  await expect(lease.claim('failed', failedAt)).resolves.toBeNull();
  expect(await readUpdatedAt('failed')).toEqual(failedAt);
});

it('renews only an ARCHIVING row', async () => {
  const old = new Date(Date.now() - 10 * 60_000);
  await workspace('archiving', 'ARCHIVING', old);
  await workspace('archived', 'ARCHIVED', old);
  const renewedAt = new Date();

  expect(await accessor.renewArchiving('archiving', renewedAt)).toBe(true);
  expect(await accessor.renewArchiving('archived', renewedAt)).toBe(false);
  expect(await readUpdatedAt('archiving')).toEqual(renewedAt);
  expect(await readUpdatedAt('archived')).toEqual(old);
});

it('lists only ARCHIVING rows whose lease is stale, oldest first and bounded', async () => {
  const now = Date.now();
  await workspace('older', 'ARCHIVING', new Date(now - 3 * staleAfterMs));
  await workspace('old', 'ARCHIVING', new Date(now - 2 * staleAfterMs));
  await workspace('oldest', 'ARCHIVING', new Date(now - 4 * staleAfterMs));
  await workspace('fresh', 'ARCHIVING', new Date(now - staleAfterMs / 2));
  await workspace('failed', 'FAILED', new Date(now - 4 * staleAfterMs));

  expect(await lease.findStaleIds(2)).toEqual(['oldest', 'older']);
  expect(await lease.findStaleIds(10)).toEqual(['oldest', 'older', 'old']);
});

it('lists a lease exactly at the threshold, which isStale also counts as stale', async () => {
  const now = Date.now();
  await workspace('boundary', 'ARCHIVING', new Date(now - staleAfterMs));
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(now);
    expect(lease.isStale(new Date(now - staleAfterMs))).toBe(true);
    expect(await lease.findStaleIds(10)).toEqual(['boundary']);
  } finally {
    vi.useRealTimers();
  }
});

it('finds archived workspaces only among the given IDs of the given project', async () => {
  const at = new Date();
  await workspace('a-archived', 'ARCHIVED', at, 'a');
  await workspace('a-ready', 'READY', at, 'a');
  await workspace('a-unlisted', 'ARCHIVED', at, 'a');
  await workspace('b-archived', 'ARCHIVED', at, 'b');

  expect(
    await accessor.findArchivedIds('a', ['a-archived', 'a-ready', 'b-archived', 'missing'])
  ).toEqual(new Set(['a-archived']));
});
