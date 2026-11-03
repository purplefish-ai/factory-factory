import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { type PRObservation, prFactPayloadSchema } from '@/shared/schemas/pr-event.schema';
import type { PrismaClient } from '@prisma-gen/client';
import { workspacePrEventAccessor } from './workspace-pr-event.accessor';
import { workspacePrAccessor } from './workspace-pr.accessor';

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
const OLD = new Date('2026-01-01T00:00:00.000Z');
const CUTOFF = new Date('2026-01-02T00:00:00.000Z');
const RECENT = new Date('2026-01-03T00:00:00.000Z');

beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
}, 30_000);
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});
beforeEach(async () => {
  await db.prisma.workspacePREvent.deleteMany();
  await db.prisma.workspacePRDelivery.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath: '/tmp/repo',
      worktreeBasePath: '/tmp/worktrees',
    },
  });
  for (const [id, status] of [
    ['w', 'READY'],
    ['archived', 'ARCHIVED'],
  ] as const) {
    await db.prisma.workspace.create({
      data: {
        id,
        projectId: 'project',
        name: id,
        status,
        prMonitoring: { create: { enabled: true } },
        prs: { create: { id: `${id}-pr`, url: redObservation.url } },
      },
    });
  }
});

function factPayload(workspaceId: string, kind: string) {
  return kind === 'MONITORING_ENABLED'
    ? { kind, workspaceId, bindingRevision: 1, replyToPrComments: false }
    : {
        kind,
        target: { workspaceId, prId: `${workspaceId}-pr` },
        observation: redObservation,
        ...(kind === 'REVIEW_FEEDBACK' ? { reviews: [] } : {}),
      };
}

type Row = {
  id: string;
  workspaceId?: string;
  kind?: string;
  state: string;
  createdAt?: Date;
  batchId?: string;
  deliveryId?: string;
  deliverySessionId?: string;
  claimedAt?: Date;
};
async function createEvents(rows: Row[]) {
  for (const row of rows) {
    const workspaceId = row.workspaceId ?? 'w';
    const kind = row.kind ?? 'REVIEW_FEEDBACK';
    await db.prisma.workspacePREvent.create({
      data: {
        id: row.id,
        workspaceId,
        prId: kind === 'MONITORING_ENABLED' ? null : `${workspaceId}-pr`,
        kind,
        deduplicationKey: `key:${row.id}`,
        payload: factPayload(workspaceId, kind),
        state: row.state,
        createdAt: row.createdAt ?? OLD,
        batchId: row.batchId ?? null,
        deliveryId: row.deliveryId ?? null,
        deliverySessionId: row.deliverySessionId ?? null,
        claimedAt: row.claimedAt ?? null,
      },
    });
  }
}
async function remainingIds() {
  return (
    await db.prisma.workspacePREvent.findMany({ select: { id: true }, orderBy: { id: 'asc' } })
  ).map((row) => row.id);
}

it('prunes only old, unclaimed terminal facts and keeps live and delivery evidence', async () => {
  for (const [id, state] of [
    ['delivered-batch', 'DELIVERED'],
    ['cancelled-batch', 'CANCELLED'],
    ['blocked-batch', 'BLOCKED'],
  ] as const) {
    await db.prisma.workspacePRDelivery.create({
      data: { id, workspaceId: 'w', eventIds: [`${id}-member`], state, attempts: 1 },
    });
  }
  await createEvents([
    { id: 'superseded', state: 'SUPERSEDED' },
    { id: 'cancelled', state: 'CANCELLED', kind: 'CI_FAILED' },
    { id: 'archived-superseded', workspaceId: 'archived', state: 'SUPERSEDED' },
    { id: 'merged-superseded', state: 'SUPERSEDED', kind: 'PR_MERGED' },
    // Live facts and reducer history.
    { id: 'pending', state: 'PENDING' },
    { id: 'dispatching', state: 'DISPATCHING' },
    { id: 'delivered', state: 'DELIVERED' },
    { id: 'archived-pending', workspaceId: 'archived', state: 'PENDING' },
    // Too recent.
    { id: 'recent-superseded', state: 'SUPERSEDED', createdAt: RECENT },
    { id: 'boundary-superseded', state: 'SUPERSEDED', createdAt: CUTOFF },
    // Keys without a transition sequence.
    { id: 'recovered-superseded', state: 'SUPERSEDED', kind: 'CI_RECOVERED' },
    { id: 'control-cancelled', state: 'CANCELLED', kind: 'MONITORING_ENABLED' },
    // Frozen delivery members, whatever their own state.
    { id: 'delivered-batch-member', state: 'SUPERSEDED', batchId: 'delivered-batch' },
    { id: 'cancelled-batch-member', state: 'CANCELLED', batchId: 'cancelled-batch' },
    { id: 'blocked-batch-member', state: 'SUPERSEDED', batchId: 'blocked-batch' },
    // Legacy receipt evidence, including incomplete metadata.
    { id: 'legacy-receipt', state: 'SUPERSEDED', deliveryId: 'legacy' },
    { id: 'empty-receipt', state: 'CANCELLED', deliveryId: '' },
    { id: 'legacy-session', state: 'SUPERSEDED', deliverySessionId: 'session' },
    { id: 'legacy-claim', state: 'CANCELLED', claimedAt: OLD },
  ]);

  expect(await workspacePrEventAccessor.pruneTerminalEvents({ before: CUTOFF, limit: 100 })).toBe(
    4
  );

  expect(await remainingIds()).toEqual(
    [
      'archived-pending',
      'blocked-batch-member',
      'boundary-superseded',
      'cancelled-batch-member',
      'control-cancelled',
      'delivered',
      'delivered-batch-member',
      'dispatching',
      'empty-receipt',
      'legacy-claim',
      'legacy-receipt',
      'legacy-session',
      'pending',
      'recent-superseded',
      'recovered-superseded',
    ].sort()
  );
  // Frozen batches keep the complete membership that backup export validates.
  const events = await db.prisma.workspacePREvent.findMany({ where: { workspaceId: 'w' } });
  const deliveries = await db.prisma.workspacePRDelivery.findMany({
    where: { state: { not: 'BLOCKED' } },
  });
  expect(() => workspacePrEventAccessor.exportEvents(events, deliveries)).not.toThrow();
  expect(await workspacePrEventAccessor.pruneTerminalEvents({ before: CUTOFF, limit: 100 })).toBe(
    0
  );
});

it('deletes at most one batch per call, oldest first', async () => {
  await createEvents(
    [3, 1, 4, 2, 5].map((minute) => ({
      id: `superseded-${minute}`,
      state: 'SUPERSEDED',
      createdAt: new Date(OLD.getTime() + minute * 60_000),
    }))
  );

  expect(await workspacePrEventAccessor.pruneTerminalEvents({ before: CUTOFF, limit: 2 })).toBe(2);
  expect(await remainingIds()).toEqual(['superseded-3', 'superseded-4', 'superseded-5']);
  expect(await workspacePrEventAccessor.pruneTerminalEvents({ before: CUTOFF, limit: 2 })).toBe(2);
  expect(await workspacePrEventAccessor.pruneTerminalEvents({ before: CUTOFF, limit: 2 })).toBe(1);
  expect(await remainingIds()).toEqual([]);
});

const review = (identity: string) => ({
  identity,
  contentHash: `${identity}-hash`,
  author: 'reviewer',
  body: `Please fix ${identity}`,
  path: 'a.ts',
  line: 1,
  url: redObservation.url,
  activityAt: redObservation.observedAt,
});
const green: PRObservation = { ...redObservation, ciStatus: 'SUCCESS', checks: [] };

it('keeps delivered history so pruning cannot re-emit delivered or pending feedback', async () => {
  const target = { workspaceId: 'w', prId: 'w-pr' };
  let revision = 0;
  const accept = async (headSha: string, reviews: ReturnType<typeof review>[]) => {
    const result = await workspacePrAccessor.acceptMonitoredObservation({
      target,
      expectedPrRevision: revision++,
      expectedEventEpoch: 0,
      observation: { ...green, headSha, actionableReviews: reviews },
    });
    expect(result.applied).toBe(true);
    return result.eventIds;
  };
  const reviewsOf = async (ids: string[]) =>
    (await db.prisma.workspacePREvent.findMany({ where: { id: { in: ids } } })).map((row) => {
      const payload = prFactPayloadSchema.parse(row.payload);
      return payload.kind === 'REVIEW_FEEDBACK' ? payload.reviews[0]?.identity : payload.kind;
    });

  const [first] = await accept('head-1', [review('r1')]);
  if (!first) {
    throw new Error('Expected feedback for r1');
  }
  await db.prisma.workspacePRDelivery.create({
    data: {
      id: 'delivery-1',
      workspaceId: 'w',
      eventIds: [first],
      state: 'DELIVERED',
      deliveredAt: new Date(),
    },
  });
  await db.prisma.workspacePREvent.update({
    where: { id: first },
    data: { batchId: 'delivery-1' },
  });
  const [second] = await accept('head-1', [review('r1'), review('r2')]);
  // A new head supersedes undelivered r2 and re-emits it; delivered r1 stays quiet.
  const reemitted = await accept('head-2', [review('r1'), review('r2')]);
  expect(await reviewsOf(reemitted)).toEqual(['r2']);
  const superseded = await db.prisma.workspacePREvent.findMany({ where: { state: 'SUPERSEDED' } });
  expect(superseded.map((row) => row.id)).toEqual([second]);

  await db.prisma.workspacePREvent.updateMany({ data: { createdAt: OLD } });
  expect(await workspacePrEventAccessor.pruneTerminalEvents({ before: CUTOFF, limit: 100 })).toBe(
    1
  );
  expect((await remainingIds()).sort()).toEqual([first, ...reemitted].sort());

  // The same observation emits nothing; another head re-emits only undelivered r2.
  expect(await accept('head-2', [review('r1'), review('r2')])).toEqual([]);
  const next = await accept('head-3', [review('r1'), review('r2')]);
  expect(await reviewsOf(next)).toEqual(['r2']);
  expect(next).not.toContain(second);
});
