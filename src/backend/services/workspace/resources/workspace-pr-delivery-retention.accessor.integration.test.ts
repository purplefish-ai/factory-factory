import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { Prisma, type PrismaClient } from '@prisma-gen/client';
import { workspacePrDeliveryAccessor } from './workspace-pr-delivery.accessor';
import { workspacePrEventAccessor } from './workspace-pr-event.accessor';
import { findPrunableDeliveryIds } from './workspace-pr-ledger-reads.accessor';

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
/** `w`'s current epoch: old epochs below it sort on both sides of its key prefix. */
const EPOCH = 12;

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
  const workspaces = [
    { id: 'w', status: 'READY', eventEpoch: EPOCH, prs: ['p', 'detached'] },
    { id: 'archived', status: 'ARCHIVED', eventEpoch: 1, prs: ['archived-pr'] },
    { id: 'archiving', status: 'ARCHIVING', eventEpoch: EPOCH, prs: ['archiving-pr'] },
    { id: 'unmonitored', status: 'READY', eventEpoch: null, prs: ['unmonitored-pr'] },
  ] as const;
  for (const workspace of workspaces) {
    await db.prisma.workspace.create({
      data: {
        id: workspace.id,
        projectId: 'project',
        name: workspace.id,
        status: workspace.status,
        ...(workspace.eventEpoch === null
          ? {}
          : { prMonitoring: { create: { enabled: true, eventEpoch: workspace.eventEpoch } } }),
        prs: {
          create: workspace.prs.map((id) => ({
            id,
            url: `https://github.com/org/repo/pull/${id}`,
            detachedAt: id === 'detached' ? OLD : null,
          })),
        },
      },
    });
  }
});

const PR_WORKSPACE: Record<string, string> = {
  p: 'w',
  detached: 'w',
  'archived-pr': 'archived',
  'archiving-pr': 'archiving',
  'unmonitored-pr': 'unmonitored',
};

// One value per legacy receipt/frozen column; any one of them keeps a unit.
const legacyValues = {
  deliveryId: 'legacy',
  deliverySessionId: 'session',
  deliveryProvider: 'CLAUDE',
  deliveryProviderSessionId: 'provider-session',
  deliveryBindingRevision: 1,
  deliveryText: 'frozen text',
  claimedAt: OLD,
  deliveredAt: OLD,
};
const legacyFields = Object.keys(legacyValues) as (keyof typeof legacyValues)[];
type Member = {
  id: string;
  key: string;
  prId?: string | null;
  workspaceId?: string;
  kind?: string;
  state?: string;
  createdAt?: Date;
  legacy?: Partial<typeof legacyValues>;
};

function payload(workspaceId: string, prId: string | null, kind: string) {
  return kind === 'MONITORING_ENABLED' || prId === null
    ? { kind: 'MONITORING_ENABLED', workspaceId, bindingRevision: 1, replyToPrComments: false }
    : {
        kind,
        target: { workspaceId, prId },
        observation: redObservation,
        ...(kind === 'REVIEW_FEEDBACK' ? { reviews: [] } : {}),
      };
}

async function createEvent(member: Member, batchId: string | null) {
  const prId = member.prId === undefined ? 'p' : member.prId;
  const workspaceId = member.workspaceId ?? (prId ? (PR_WORKSPACE[prId] ?? 'w') : 'w');
  const kind = member.kind ?? (prId ? 'CI_FAILED' : 'MONITORING_ENABLED');
  await db.prisma.workspacePREvent.create({
    data: {
      id: member.id,
      workspaceId,
      prId,
      kind,
      deduplicationKey: member.key,
      payload: payload(workspaceId, prId, kind),
      state: member.state ?? 'PENDING',
      createdAt: member.createdAt ?? OLD,
      batchId,
      ...member.legacy,
    },
  });
}

async function createUnit(unit: {
  id: string;
  workspaceId?: string;
  state?: string;
  members: Member[];
  eventIds?: Prisma.InputJsonValue;
  claimedAt?: Date;
  deliveredAt?: Date;
}) {
  await db.prisma.workspacePRDelivery.create({
    data: {
      id: unit.id,
      workspaceId: unit.workspaceId ?? 'w',
      eventIds: unit.eventIds ?? unit.members.map((member) => member.id),
      state: unit.state ?? 'DELIVERED',
      sessionId: 'session',
      provider: 'CLAUDE',
      providerSessionId: 'provider-session',
      bindingRevision: 1,
      text: `frozen ${unit.id}`,
      attempts: 1,
      claimedAt: unit.claimedAt ?? OLD,
      deliveredAt: unit.deliveredAt ?? OLD,
    },
  });
  for (const member of unit.members) {
    await createEvent(member, unit.id);
  }
}

async function remaining() {
  const [deliveries, events] = await Promise.all([
    db.prisma.workspacePRDelivery.findMany({ select: { id: true }, orderBy: { id: 'asc' } }),
    db.prisma.workspacePREvent.findMany({ select: { id: true }, orderBy: { id: 'asc' } }),
  ]);
  return { deliveries: deliveries.map((row) => row.id), events: events.map((row) => row.id) };
}

function prune(limit = 100, afterId = '') {
  return workspacePrDeliveryAccessor.pruneSettledDeliveries({ before: CUTOFF, afterId, limit });
}

it('prunes settled units of earlier epochs and of ARCHIVED workspaces with every member', async () => {
  await createUnit({
    id: 'u-epoch-11',
    members: [
      { id: 'u-epoch-11-a', key: 'p:epoch:11:a' },
      { id: 'u-epoch-11-b', key: 'p:epoch:11:b', kind: 'REVIEW_FEEDBACK' },
    ],
  });
  // `9` sorts after `12`, so this key lies in the range above the current prefix.
  await createUnit({
    id: 'u-epoch-9',
    state: 'CANCELLED',
    members: [{ id: 'u-epoch-9-a', key: 'p:epoch:9:a' }],
  });
  await createUnit({
    id: 'u-epoch-0',
    state: 'SUPERSEDED',
    members: [{ id: 'u-epoch-0-a', key: `p:epoch:0:${'f'.repeat(64)}`, kind: 'PR_MERGED' }],
  });
  await createUnit({
    id: 'u-detached',
    members: [{ id: 'u-detached-a', key: 'detached:epoch:3:a', prId: 'detached' }],
  });
  // A MAIN batch across PRs, all of them outside the current epoch.
  await createUnit({
    id: 'u-two-prs',
    members: [
      { id: 'u-two-prs-a', key: 'p:epoch:1:a' },
      { id: 'u-two-prs-b', key: 'detached:epoch:2:b', prId: 'detached' },
    ],
  });
  // ARCHIVED is final: even its current epoch has no reader.
  await createUnit({
    id: 'u-archived',
    workspaceId: 'archived',
    members: [{ id: 'u-archived-a', key: 'archived-pr:epoch:1:a', prId: 'archived-pr' }],
  });
  await createUnit({
    id: 'u-archived-cancelled',
    workspaceId: 'archived',
    state: 'CANCELLED',
    members: [{ id: 'u-archived-cancelled-a', key: 'legacy-key', prId: 'archived-pr' }],
  });
  // The ARCHIVED branch needs no monitoring row (no epoch is compared).
  await db.prisma.workspace.create({
    data: {
      id: 'archived-unmonitored',
      projectId: 'project',
      name: 'archived-unmonitored',
      status: 'ARCHIVED',
      prs: { create: { id: 'archived-unmonitored-pr', url: redObservation.url } },
    },
  });
  await createUnit({
    id: 'u-archived-unmonitored',
    workspaceId: 'archived-unmonitored',
    members: [
      {
        id: 'u-archived-unmonitored-a',
        key: 'archived-unmonitored-pr:epoch:0:a',
        prId: 'archived-unmonitored-pr',
        workspaceId: 'archived-unmonitored',
      },
    ],
  });

  expect(await prune()).toEqual({
    selected: 8,
    lastId: 'u-two-prs',
    deliveries: 8,
    events: 10,
  });
  expect(await remaining()).toEqual({ deliveries: [], events: [] });
  expect(await prune()).toEqual({ selected: 0, lastId: null, deliveries: 0, events: 0 });
});

it('keeps live, quarantined, unknown, legacy, current, recent and unparseable units', async () => {
  for (const state of ['PENDING', 'DISPATCHING', 'BLOCKED', 'DISMISSED', 'MYSTERY']) {
    await createUnit({
      id: `u-${state}`,
      state,
      members: [{ id: `u-${state}-a`, key: `p:epoch:1:${state}` }],
    });
  }
  for (const field of legacyFields) {
    await createUnit({
      id: `u-legacy-${field}`,
      members: [
        {
          id: `u-legacy-${field}-a`,
          key: `p:epoch:1:legacy-${field}`,
          legacy: { [field]: legacyValues[field] },
        },
      ],
    });
  }
  // Legacy receipt evidence naming the delivery, and evidence bound to nothing.
  await createUnit({ id: 'u-named', members: [{ id: 'u-named-a', key: 'p:epoch:1:named' }] });
  await createEvent(
    { id: 'u-named-legacy', key: 'p:epoch:1:named-legacy', legacy: { deliveryId: 'u-named' } },
    null
  );
  await createEvent(
    {
      id: 'unbound-legacy',
      key: 'p:epoch:1:unbound',
      state: 'DELIVERED',
      legacy: { deliveryId: 'gone', deliverySessionId: 'session' },
    },
    null
  );
  await createUnit({
    id: 'u-control',
    members: [{ id: 'u-control-a', key: 'enabled:1', prId: null }],
  });
  // The reducer reads these: the current epoch of a live workspace, attached or
  // detached (re-attaching reuses the row and the epoch).
  await createUnit({
    id: 'u-current',
    members: [{ id: 'u-current-a', key: `p:epoch:${EPOCH}:a` }],
  });
  await createUnit({
    id: 'u-current-detached',
    members: [{ id: 'u-current-detached-a', key: `detached:epoch:${EPOCH}:a`, prId: 'detached' }],
  });
  // ARCHIVING can roll back to READY; without monitoring there is no known epoch.
  await createUnit({
    id: 'u-archiving',
    workspaceId: 'archiving',
    members: [{ id: 'u-archiving-a', key: `archiving-pr:epoch:${EPOCH}:a`, prId: 'archiving-pr' }],
  });
  await createUnit({
    id: 'u-unmonitored',
    workspaceId: 'unmonitored',
    members: [{ id: 'u-unmonitored-a', key: 'unmonitored-pr:epoch:0:a', prId: 'unmonitored-pr' }],
  });
  // Too recent: a member, the claim, the settlement, or exactly at the cutoff.
  await createUnit({
    id: 'u-recent-member',
    members: [{ id: 'u-recent-member-a', key: 'p:epoch:1:recent', createdAt: RECENT }],
  });
  await createUnit({
    id: 'u-recent-claim',
    claimedAt: RECENT,
    members: [{ id: 'u-recent-claim-a', key: 'p:epoch:1:claim' }],
  });
  await createUnit({
    id: 'u-recent-settled',
    deliveredAt: RECENT,
    members: [{ id: 'u-recent-settled-a', key: 'p:epoch:1:settled' }],
  });
  await createUnit({
    id: 'u-boundary',
    members: [{ id: 'u-boundary-a', key: 'p:epoch:1:boundary', createdAt: CUTOFF }],
  });
  // Keys that are not `<prId>:epoch:<n>:` with n below the current epoch.
  for (const [name, key] of [
    ['future', `p:epoch:${EPOCH + 1}:a`],
    ['current-padded', `p:epoch:0${EPOCH}:a`],
    ['word', 'p:epoch:x:a'],
    ['empty', 'p:epoch::a'],
    ['negative', 'p:epoch:-1:a'],
    ['spaced', 'p:epoch: 1:a'],
    ['no-colon', 'p:epoch:1'],
    ['upper-case', 'P:EPOCH:1:a'],
    ['other-pr', 'detached:epoch:1:a'],
    ['recovered', 'recovered:row:uuid'],
  ] as const) {
    await createUnit({ id: `u-key-${name}`, members: [{ id: `u-key-${name}-a`, key }] });
  }
  const before = await remaining();

  expect(await prune()).toEqual({ selected: 0, lastId: null, deliveries: 0, events: 0 });
  expect(await remaining()).toEqual(before);
});

it('keeps a delivery whole when any member or its membership is not prunable', async () => {
  const old = (id: string, epoch = 1) => ({ id, key: `p:epoch:${epoch}:${id}` });
  await createUnit({ id: 'u-current-member', members: [old('a1'), old('a2', EPOCH)] });
  await createUnit({
    id: 'u-recent-member',
    members: [old('b1'), { ...old('b2'), createdAt: RECENT }],
  });
  await createUnit({
    id: 'u-control-member',
    members: [old('c1'), { id: 'c2', key: 'enabled:2', prId: null }],
  });
  await createUnit({
    id: 'u-legacy-member',
    members: [old('d1'), { ...old('d2'), legacy: { deliveryText: 'frozen text' } }],
  });
  await createUnit({
    id: 'u-foreign-member',
    members: [
      old('e1'),
      { id: 'e2', key: 'archived-pr:epoch:0:e2', prId: 'archived-pr', workspaceId: 'archived' },
    ],
  });
  await createUnit({ id: 'u-missing-member', eventIds: ['f1', 'ghost'], members: [old('f1')] });
  await createUnit({ id: 'u-extra-member', eventIds: ['g1'], members: [old('g1'), old('g2')] });
  await createUnit({ id: 'u-duplicate', eventIds: ['h1', 'h1'], members: [old('h1')] });
  await createUnit({
    id: 'u-duplicate-extra',
    eventIds: ['i1', 'i1'],
    members: [old('i1'), old('i2')],
  });
  await createUnit({ id: 'u-empty', eventIds: [], members: [] });
  await createUnit({ id: 'u-object', eventIds: { j1: true }, members: [old('j1')] });
  await createUnit({ id: 'u-string', eventIds: 'k1', members: [old('k1')] });
  await createUnit({ id: 'u-number', eventIds: ['l1', 7], members: [old('l1')] });
  const before = await remaining();

  expect(await prune()).toEqual({ selected: 0, lastId: null, deliveries: 0, events: 0 });
  expect(await remaining()).toEqual(before);
});

it('deletes one bounded batch per call and continues after the cursor', async () => {
  for (const id of ['u-3', 'u-1', 'u-2']) {
    await createUnit({ id, members: [{ id: `${id}-a`, key: `p:epoch:1:${id}` }] });
  }
  await createUnit({ id: 'u-0', members: [{ id: 'u-0-a', key: `p:epoch:${EPOCH}:a` }] });

  expect(await prune(2)).toEqual({ selected: 2, lastId: 'u-2', deliveries: 2, events: 2 });
  expect((await remaining()).deliveries).toEqual(['u-0', 'u-3']);
  expect(await prune(2, 'u-2')).toEqual({ selected: 1, lastId: 'u-3', deliveries: 1, events: 1 });
  expect(await remaining()).toEqual({ deliveries: ['u-0'], events: ['u-0-a'] });
});

it('re-checks each unit in the deleting transaction', async () => {
  await createUnit({ id: 'u-claimed', members: [{ id: 'u-claimed-a', key: 'p:epoch:1:a' }] });
  await createUnit({ id: 'u-kept', members: [{ id: 'u-kept-a', key: 'p:epoch:1:b' }] });
  const transaction = db.prisma.$transaction.bind(db.prisma);
  const spy = vi.spyOn(db.prisma, '$transaction').mockImplementationOnce(async (...args) => {
    // Something changes between selection and delete: a delivery reopens and
    // a current-epoch fact joins the other one.
    await db.prisma.workspacePRDelivery.update({
      where: { id: 'u-claimed' },
      data: { state: 'PENDING' },
    });
    await createEvent({ id: 'u-kept-b', key: `p:epoch:${EPOCH}:b` }, 'u-kept');
    await db.prisma.workspacePRDelivery.update({
      where: { id: 'u-kept' },
      data: { eventIds: ['u-kept-a', 'u-kept-b'] },
    });
    return Reflect.apply(transaction, db.prisma, args);
  });
  try {
    expect(await prune()).toEqual({ selected: 2, lastId: 'u-kept', deliveries: 0, events: 0 });
  } finally {
    spy.mockRestore();
  }
  expect(await remaining()).toEqual({
    deliveries: ['u-claimed', 'u-kept'],
    events: ['u-claimed-a', 'u-kept-a', 'u-kept-b'],
  });
});

it('leaves backup export valid and identical for everything it keeps', async () => {
  await createUnit({ id: 'u-old', members: [{ id: 'u-old-a', key: 'p:epoch:1:a' }] });
  await createUnit({
    id: 'u-current',
    members: [
      { id: 'u-current-a', key: `p:epoch:${EPOCH}:a` },
      { id: 'u-current-b', key: `p:epoch:${EPOCH}:b` },
    ],
  });
  await createUnit({
    id: 'u-half',
    members: [
      { id: 'u-half-a', key: 'p:epoch:1:half' },
      { id: 'u-half-b', key: `p:epoch:${EPOCH}:half` },
    ],
  });
  await createUnit({
    id: 'u-archived',
    workspaceId: 'archived',
    members: [{ id: 'u-archived-a', key: 'archived-pr:epoch:1:a', prId: 'archived-pr' }],
  });
  await createEvent({ id: 'pending', key: `p:epoch:${EPOCH}:pending` }, null);
  const exported = async (workspaceId: string) =>
    workspacePrEventAccessor.exportEvents(
      await db.prisma.workspacePREvent.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } }),
      await db.prisma.workspacePRDelivery.findMany({ where: { workspaceId } })
    );
  const before = { w: await exported('w'), archived: await exported('archived') };

  expect(await prune()).toMatchObject({ deliveries: 2, events: 2 });

  const kept = new Set((await remaining()).events);
  expect(await exported('w')).toEqual(before.w.filter((event) => kept.has(event.id)));
  expect(await exported('archived')).toEqual([]);
  expect([...kept].sort()).toEqual(
    ['pending', 'u-current-a', 'u-current-b', 'u-half-a', 'u-half-b'].sort()
  );
});

it('leaves the reducer history of every current epoch unchanged', async () => {
  for (const epoch of [1, 9, 11, EPOCH]) {
    for (const prId of ['p', 'detached']) {
      const id = `${prId}-${epoch}`;
      await createUnit({
        id: `u-${id}`,
        state: epoch === 9 ? 'CANCELLED' : 'DELIVERED',
        members: [
          { id: `${id}-a`, key: `${prId}:epoch:${epoch}:a`, prId },
          { id: `${id}-b`, key: `${prId}:epoch:${epoch}:b`, prId, kind: 'REVIEW_FEEDBACK' },
        ],
      });
      await createEvent({ id: `${id}-pending`, key: `${prId}:epoch:${epoch}:c`, prId }, null);
    }
  }
  const history = () =>
    Promise.all(
      ['p', 'detached'].map((prId) => workspacePrEventAccessor.listForPR(db.prisma, prId, EPOCH))
    );
  const before = await history();
  expect(before.flat()).toHaveLength(6);
  expect(await workspacePrEventAccessor.listForPR(db.prisma, 'p', 11)).toHaveLength(3);

  expect(await prune()).toMatchObject({ deliveries: 6, events: 12 });

  expect(await history()).toEqual(before);
  // Only the unclaimed fact of an old epoch is left, for the terminal rule to cancel or prune.
  expect(
    (await workspacePrEventAccessor.listForPR(db.prisma, 'p', 11)).map((event) => event.id)
  ).toEqual(['p-11-pending']);
});

it('finds candidates through indexes without visiting current-epoch history', async () => {
  let query: Prisma.Sql | undefined;
  const client = {
    $queryRaw: (strings: TemplateStringsArray, ...values: Prisma.Sql['values']) => {
      query = Prisma.sql(strings, ...values);
      return Promise.resolve([]);
    },
  } as unknown as Prisma.TransactionClient;
  await findPrunableDeliveryIds(client, { before: CUTOFF, afterId: '', limit: 25 });
  if (!query) {
    throw new Error('Expected the candidate query');
  }
  const plan = z
    .array(z.object({ detail: z.string() }))
    .parse(await db.prisma.$queryRawUnsafe(`EXPLAIN QUERY PLAN ${query.sql}`, ...query.values));
  const details = plan.map((row) => row.detail);

  expect(details).toContainEqual(
    expect.stringMatching(
      /^SEARCH m USING INDEX WorkspacePREvent_prId_deduplicationKey_key \(prId=\? AND deduplicationKey>\? AND deduplicationKey<\?\)/
    )
  );
  expect(details).toContainEqual(
    expect.stringMatching(/^SEARCH d USING INDEX WorkspacePRDelivery_workspaceId_state_idx/)
  );
  expect(details).toContainEqual(
    expect.stringMatching(/^SEARCH w USING .*INDEX Workspace_status_idx/)
  );
  // No ledger or delivery table is scanned in full, nor any index range of
  // bound facts; the loop is driven by PR rows and the candidate list.
  expect(details.filter((detail) => /^SCAN (m|d|e|b|l)\b/.test(detail))).toEqual([]);
  expect(details.filter((detail) => /batchId>/.test(detail))).toEqual([]);
  expect(details).toContain('SCAN c');
});
