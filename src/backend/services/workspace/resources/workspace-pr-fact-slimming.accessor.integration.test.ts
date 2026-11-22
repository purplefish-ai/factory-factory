import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildPREventBatch } from '@/backend/prompts/pr-event';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { prFactPayloadSchema } from '@/shared/schemas/pr-event.schema';
import type { PrismaClient } from '@prisma-gen/client';
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
const target = { workspaceId: 'w', prId: 'p' };

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
  await db.prisma.workspace.create({
    data: {
      id: 'w',
      projectId: 'project',
      name: 'w',
      status: 'READY',
      prs: { create: { id: 'p', url: redObservation.url } },
    },
  });
});

const review = (identity: string) => ({
  identity,
  contentHash: `${identity}-hash`,
  author: 'reviewer',
  body: `Please fix "${identity}" <now>\n\tü ✓ \\ ${'x'.repeat(2000)}`,
  path: 'a.ts',
  line: 1,
  url: redObservation.url,
  activityAt: redObservation.observedAt,
});
// An observation as facts stored it before #3288, with text that needs escaping.
const fatObservation = {
  ...redObservation,
  title: 'Fix "quotes", <tags> & ünïcode — ✓\nsecond line',
  actionableReviews: [review('r1'), review('r2')],
  resolvedReviewIds: ['r0'],
};
const { resolvedReviewIds: _resolved, ...withoutResolved } = fatObservation;

const rows: Record<string, unknown> = {
  'a-fat-ci': { kind: 'CI_FAILED', target, observation: fatObservation },
  'b-fat-feedback': {
    kind: 'REVIEW_FEEDBACK',
    target,
    observation: withoutResolved,
    reviews: [review('r1')],
  },
  'c-resolved-only': {
    kind: 'CI_RECOVERED',
    target,
    observation: { ...redObservation, resolvedReviewIds: [] },
  },
  'd-slim': { kind: 'CONFLICT_DETECTED', target, observation: redObservation },
  'e-unparseable': {
    kind: 'CI_FAILED',
    target,
    observation: { ...fatObservation, unexpected: true },
  },
  'f-control': {
    kind: 'MONITORING_ENABLED',
    workspaceId: 'w',
    bindingRevision: 1,
    replyToPrComments: false,
  },
};
const SLIMMED = ['a-fat-ci', 'b-fat-feedback', 'c-resolved-only'];

async function createRows() {
  for (const [id, payload] of Object.entries(rows)) {
    await db.prisma.workspacePREvent.create({
      data: {
        id,
        workspaceId: 'w',
        prId: id === 'f-control' ? null : 'p',
        kind: z.object({ kind: z.string() }).parse(payload).kind,
        deduplicationKey: `p:epoch:1:${id}`,
        payload: z.json().parse(payload) ?? {},
        state: 'DELIVERED',
      },
    });
  }
}

/** The payload column exactly as SQLite stores it. */
async function storedText() {
  const stored = z
    .array(z.object({ id: z.string(), text: z.string() }))
    .parse(
      await db.prisma
        .$queryRaw`SELECT "id", CAST("payload" AS TEXT) AS "text" FROM "WorkspacePREvent" ORDER BY "id"`
    );
  return Object.fromEntries(stored.map((row) => [row.id, row.text]));
}

/** What slimming should leave: the same object, key order included, minus the review list. */
function slimmed(payload: unknown) {
  const fact = z.record(z.string(), z.json()).parse(payload);
  const { resolvedReviewIds: _ids, ...observation } = z
    .record(z.string(), z.json())
    .parse(fact.observation);
  return { ...fact, observation: { ...observation, actionableReviews: [] } };
}

it('removes only the review list from old facts, byte for byte, once', async () => {
  await createRows();
  const before = await storedText();
  // Prisma stores JSON.stringify output, so the expected text below is exact.
  for (const [id, payload] of Object.entries(rows)) {
    expect(before[id]).toBe(JSON.stringify(payload));
  }

  expect(await workspacePrEventAccessor.slimReviewLists({ afterId: '', limit: 100 })).toEqual({
    scanned: 6,
    lastId: 'f-control',
    slimmed: 3,
  });

  const after = await storedText();
  for (const [id, payload] of Object.entries(rows)) {
    expect(after[id]).toBe(SLIMMED.includes(id) ? JSON.stringify(slimmed(payload)) : before[id]);
  }
  const feedback = prFactPayloadSchema.parse(JSON.parse(after['b-fat-feedback'] ?? ''));
  expect(feedback.kind === 'REVIEW_FEEDBACK' && feedback.reviews).toEqual([review('r1')]);
  expect(Buffer.byteLength(after['a-fat-ci'] ?? '')).toBeLessThan(
    Buffer.byteLength(before['a-fat-ci'] ?? '') / 2
  );

  // Idempotent: nothing is left to rewrite, and nothing changes.
  expect(await workspacePrEventAccessor.slimReviewLists({ afterId: '', limit: 100 })).toEqual({
    scanned: 6,
    lastId: 'f-control',
    slimmed: 0,
  });
  expect(await storedText()).toEqual(after);
});

it('renders the same PR update from a slimmed fact', async () => {
  await createRows();
  const facts = async () =>
    (
      await db.prisma.workspacePREvent.findMany({
        where: { id: { in: SLIMMED } },
        orderBy: { id: 'asc' },
      })
    ).map((row) => prFactPayloadSchema.parse(row.payload));
  // Each fact alone, and all of them in one batch, under both reply policies.
  const render = (events: Awaited<ReturnType<typeof facts>>) =>
    [true, false].flatMap((replyToPrComments) =>
      [...events.map((event) => [event]), events].map((batch) =>
        buildPREventBatch({ deliveryId: 'delivery', replyToPrComments, events: batch })
      )
    );
  const fat = await facts();
  expect(fat.map((event) => event.observation.actionableReviews.length)).toEqual([2, 2, 0]);
  const before = render(fat);

  await workspacePrEventAccessor.slimReviewLists({ afterId: '', limit: 100 });

  const slim = await facts();
  expect(slim.map((event) => event.observation.actionableReviews)).toEqual([[], [], []]);
  expect(render(slim)).toEqual(before);
});

it('scans one bounded window per call and reports where to continue', async () => {
  await createRows();

  expect(await workspacePrEventAccessor.slimReviewLists({ afterId: '', limit: 2 })).toEqual({
    scanned: 2,
    lastId: 'b-fat-feedback',
    slimmed: 2,
  });
  expect(
    await workspacePrEventAccessor.slimReviewLists({ afterId: 'b-fat-feedback', limit: 2 })
  ).toEqual({ scanned: 2, lastId: 'd-slim', slimmed: 1 });
  expect(await workspacePrEventAccessor.slimReviewLists({ afterId: 'd-slim', limit: 2 })).toEqual({
    scanned: 2,
    lastId: 'f-control',
    slimmed: 0,
  });
  expect(
    await workspacePrEventAccessor.slimReviewLists({ afterId: 'f-control', limit: 2 })
  ).toEqual({ scanned: 0, lastId: null, slimmed: 0 });
});
