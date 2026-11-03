import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { Prisma, PrismaClient } from '@prisma-gen/client';
import { readDeliveryEvents } from './workspace-pr-delivery.accessor';
import { workspacePrEventAccessor } from './workspace-pr-event.accessor';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!database.prisma) {
      throw new Error('Missing test database');
    }
    return database.prisma;
  },
}));

let db: IntegrationDatabase;
const ACTIVE = ['PENDING', 'DISPATCHING', 'DELIVERED'];

beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath: '/tmp/repo',
      worktreeBasePath: '/tmp/worktrees',
    },
  });
  await db.prisma.workspace.create({
    data: { id: 'w', projectId: 'project', name: 'Workspace', status: 'READY' },
  });
  for (const id of ['p', 'q']) {
    await db.prisma.workspacePR.create({
      data: { id, workspaceId: 'w', url: `https://github.com/o/r/pull/${id}` },
    });
  }
  for (const [id, state] of [
    ['delivered', 'DELIVERED'],
    ['blocked', 'BLOCKED'],
    ['cancelled', 'CANCELLED'],
    ['dispatching', 'DISPATCHING'],
    ['legacy-delivered', 'DELIVERED'],
  ] as const) {
    await db.prisma.workspacePRDelivery.create({
      data: { id, workspaceId: 'w', eventIds: [`${id}-event`], state, attempts: 1 },
    });
  }
  const rows: Array<{
    id: string;
    prId?: string;
    key: string;
    state: string;
    batchId?: string;
    deliveryId?: string;
  }> = [
    { id: 'pending', key: 'p:epoch:1:pending', state: 'PENDING' },
    { id: 'legacy-dispatching', key: 'p:epoch:1:legacy-dispatching', state: 'DISPATCHING' },
    { id: 'unbound-delivered', key: 'p:epoch:1:unbound-delivered', state: 'DELIVERED' },
    { id: 'superseded', key: 'p:epoch:1:superseded', state: 'SUPERSEDED' },
    { id: 'cancelled', key: 'p:epoch:1:cancelled', state: 'CANCELLED' },
    // Delivery state replaces a stale event state in the projection.
    { id: 'delivered-event', key: 'p:epoch:1:d', state: 'PENDING', batchId: 'delivered' },
    { id: 'blocked-event', key: 'p:epoch:1:b', state: 'SUPERSEDED', batchId: 'blocked' },
    { id: 'cancelled-event', key: 'p:epoch:1:c', state: 'PENDING', batchId: 'cancelled' },
    { id: 'dispatching-event', key: 'p:epoch:1:x', state: 'PENDING', batchId: 'dispatching' },
    {
      id: 'legacy-delivered-event',
      key: 'p:epoch:1:legacy-receipt',
      state: 'SUPERSEDED',
      deliveryId: 'legacy-delivered',
    },
    { id: 'orphan-receipt', key: 'p:epoch:1:orphan', state: 'DISPATCHING', deliveryId: 'gone' },
    // Rows outside the current epoch or PR never reach the reducer.
    { id: 'old-pending', key: 'p:epoch:0:pending', state: 'PENDING' },
    { id: 'old-delivered', key: 'p:epoch:0:d', state: 'PENDING', batchId: 'delivered' },
    { id: 'epoch-ten', key: 'p:epoch:10:pending', state: 'PENDING' },
    { id: 'upper-case', key: 'P:EPOCH:1:pending', state: 'PENDING' },
    { id: 'other-pr', prId: 'q', key: 'q:epoch:1:pending', state: 'PENDING' },
  ];
  for (const [index, row] of rows.entries()) {
    await db.prisma.workspacePREvent.create({
      data: {
        id: row.id,
        workspaceId: 'w',
        prId: row.prId ?? 'p',
        kind: 'REVIEW_FEEDBACK',
        deduplicationKey: row.key,
        payload: { kind: 'REVIEW_FEEDBACK', body: row.id.repeat(100) },
        state: row.state,
        batchId: row.batchId ?? null,
        deliveryId: row.deliveryId ?? null,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      },
    });
  }
}, 30_000);

afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});

function recordingClient(loaded: string[]) {
  return {
    workspacePREvent: {
      findMany: async (args: Prisma.WorkspacePREventFindManyArgs) => {
        const rows = await db.prisma.workspacePREvent.findMany(args);
        loaded.push(...rows.map((row) => row.id));
        return rows;
      },
    },
    workspacePRDelivery: db.prisma.workspacePRDelivery,
  } as unknown as Prisma.TransactionClient;
}

it('returns the same reducer history as filtering the full PR history', async () => {
  const fullHistory = (await readDeliveryEvents(db.prisma, { prId: 'p' })).filter(
    (event) => ACTIVE.includes(event.state) && event.deduplicationKey.startsWith('p:epoch:1:')
  );
  const history = await workspacePrEventAccessor.listForPR(db.prisma, 'p', 1);

  expect(history).toEqual(fullHistory);
  expect(history.map((event) => [event.id, event.state])).toEqual([
    ['pending', 'PENDING'],
    ['legacy-dispatching', 'DISPATCHING'],
    ['unbound-delivered', 'DELIVERED'],
    ['delivered-event', 'DELIVERED'],
    ['blocked-event', 'DISPATCHING'],
    ['dispatching-event', 'DISPATCHING'],
    ['legacy-delivered-event', 'DELIVERED'],
    ['orphan-receipt', 'DISPATCHING'],
  ]);
  expect((await workspacePrEventAccessor.listForPR(db.prisma, 'p', 0)).map((e) => e.id)).toEqual([
    'old-pending',
    'old-delivered',
  ]);
});

it('does not load unbound inactive or out-of-epoch payloads', async () => {
  const loaded: string[] = [];
  await workspacePrEventAccessor.listForPR(recordingClient(loaded), 'p', 1);

  // Delivery-bound rows are read so their delivery state can be projected.
  expect(loaded).toEqual([
    'pending',
    'legacy-dispatching',
    'unbound-delivered',
    'delivered-event',
    'blocked-event',
    'cancelled-event',
    'dispatching-event',
    'legacy-delivered-event',
    'orphan-receipt',
  ]);
});
