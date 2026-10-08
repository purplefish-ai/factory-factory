import type { PrismaClient } from '@prisma-gen/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { workspacePrAccessor } from './workspace-pr.accessor';
import { workspacePrRatchetAccessor } from './workspace-pr-ratchet.accessor';
import {
  flattenWorkspaceRatchet,
  WORKSPACE_RATCHET_DEFAULTS,
  workspaceRatchetAccessor,
} from './workspace-ratchet.accessor';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!database.prisma) {
      throw new Error('Missing database');
    }
    return database.prisma;
  },
}));
let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
  await db.prisma.project.create({
    data: { id: 'p', name: 'P', slug: 'p', repoPath: '/tmp/p', worktreeBasePath: '/tmp/w' },
  });
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
async function setup(id: string) {
  await db.prisma.workspace.create({
    data: { id, projectId: 'p', name: id, status: 'READY', ratchet: { create: {} } },
  });
  const a = await workspacePrAccessor.attach(id, `https://github.com/o/r/pull/1`),
    b = await workspacePrAccessor.attach(id, `https://github.com/other/r/pull/1`);
  return { a: a.prId, b: b.prId };
}
it('returns immutable defaults without ownership', () => {
  const fields = flattenWorkspaceRatchet(null);
  fields.ratchetEnabled = false;
  expect(flattenWorkspaceRatchet(undefined)).toEqual(WORKSPACE_RATCHET_DEFAULTS);
});
it('observes each nonterminal PR, orders them fairly, and excludes archived workspaces', async () => {
  const { a, b } = await setup('candidates');
  await db.prisma.workspacePR.update({ where: { id: a }, data: { state: 'MERGED' } });
  expect(await workspaceRatchetAccessor.findWithPRsForRatchet()).toEqual([
    expect.objectContaining({ id: 'candidates', prId: b }),
  ]);
  expect(await workspaceRatchetAccessor.findForRatchetById('candidates')).toBeNull();
  await db.prisma.workspace.update({ where: { id: 'candidates' }, data: { status: 'ARCHIVED' } });
  expect(await workspaceRatchetAccessor.findAllForRatchetById('candidates')).toEqual([]);
});
it('atomically allows only one active PR fixer and preserves sibling history on completion', async () => {
  const { a, b } = await setup('ownership');
  const results = await Promise.all([
    workspaceRatchetAccessor.recordDispatchIfEnabled('ownership', {
      prId: a,
      sessionId: 'sa',
      snapshotKey: 'a',
      retryCount: 2,
    }),
    workspaceRatchetAccessor.recordDispatchIfEnabled('ownership', {
      prId: b,
      sessionId: 'sb',
      snapshotKey: 'b',
      retryCount: 0,
    }),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const slot = await db.prisma.workspaceRatchet.findUniqueOrThrow({
    where: { workspaceId: 'ownership' },
  });
  expect(await workspaceRatchetAccessor.recordSessionEnd('ownership', 'unrelated', 'DIED')).toBe(
    false
  );
  expect(
    await workspaceRatchetAccessor.recordSessionEnd('ownership', slot.activeSessionId!, 'DIED')
  ).toBe(true);
  const next = slot.activePrId === a ? b : a;
  expect(
    await workspaceRatchetAccessor.recordDispatchIfEnabled('ownership', {
      prId: next,
      sessionId: 'next',
      snapshotKey: 'next',
      retryCount: 0,
    })
  ).toBe(true);
  expect(
    await workspaceRatchetAccessor.recordSessionEnd('ownership', slot.activeSessionId!, 'COMPLETED')
  ).toBe(false);
  expect(
    await db.prisma.workspaceRatchet.findUnique({ where: { workspaceId: 'ownership' } })
  ).toMatchObject({ activeSessionId: 'next', activePrId: next });
  expect(
    await db.prisma.workspacePRRatchet.findUnique({ where: { prId: slot.activePrId! } })
  ).toMatchObject({ dispatchOutcome: 'DIED' });
});
it('guards dispatch on lifecycle, enabled state, PR identity and revision', async () => {
  const { a } = await setup('guards');
  expect(
    await workspaceRatchetAccessor.recordDispatchIfEnabled('other', {
      prId: a,
      sessionId: 's',
      snapshotKey: 'a',
      retryCount: 0,
    })
  ).toBe(false);
  expect(
    await workspaceRatchetAccessor.recordDispatchIfEnabled('guards', {
      prId: a,
      expectedRevision: 99,
      sessionId: 's',
      snapshotKey: 'a',
      retryCount: 0,
    })
  ).toBe(false);
  await workspaceRatchetAccessor.disable('guards');
  expect(
    await workspaceRatchetAccessor.recordDispatchIfEnabled('guards', {
      prId: a,
      sessionId: 's',
      snapshotKey: 'a',
      retryCount: 0,
    })
  ).toBe(false);
  expect(await workspaceRatchetAccessor.recordCheckIfEnabled('guards', new Date(), a)).toBe(false);
  await workspaceRatchetAccessor.enable('guards');
  expect(await workspaceRatchetAccessor.recordCheckIfEnabled('guards', new Date(), a)).toBe(true);
  await db.prisma.workspacePR.update({ where: { id: a }, data: { state: 'CLOSED' } });
  expect(
    await workspaceRatchetAccessor.recordDispatchIfEnabled('guards', {
      prId: a,
      sessionId: 's',
      snapshotKey: 'a',
      retryCount: 0,
    })
  ).toBe(false);
});
it('adopts only exact persisted ownership and keeps the dispatch snapshot', async () => {
  const { a, b } = await setup('adopt');
  await workspaceRatchetAccessor.recordDispatchIfEnabled('adopt', {
    prId: a,
    sessionId: 's',
    snapshotKey: 'old',
    retryCount: 1,
  });
  expect(await workspaceRatchetAccessor.adoptActiveSessionIfEnabled('adopt', 's', b)).toBe(false);
  expect(await workspaceRatchetAccessor.adoptActiveSessionIfEnabled('adopt', 's', a)).toBe(true);
  expect(await db.prisma.workspacePRRatchet.findUnique({ where: { prId: a } })).toMatchObject({
    dispatchSnapshotKey: 'old',
    dispatchRetryCount: 1,
  });
});
it('marks stalls only for the exact dispatch and resets settled records with a CAS', async () => {
  const { a, b } = await setup('stall');
  await workspaceRatchetAccessor.recordDispatchIfEnabled('stall', {
    prId: a,
    sessionId: 's',
    snapshotKey: 'a',
    retryCount: 3,
  });
  await workspaceRatchetAccessor.recordSessionEnd('stall', 's', 'DIED');
  expect(await workspaceRatchetAccessor.markDispatchStalled('stall', 'wrong', a)).toBe(false);
  expect(await workspaceRatchetAccessor.markDispatchStalled('stall', 'a', b)).toBe(false);
  expect(await workspaceRatchetAccessor.markDispatchStalled('stall', 'a', a)).toBe(true);
  expect(await workspaceRatchetAccessor.markDispatchStalled('stall', 'a', a)).toBe(false);
  await db.prisma.$transaction(async (tx) => {
    const guard = await workspacePrRatchetAccessor.read(tx, a);
    expect(await workspacePrRatchetAccessor.reset(tx, a, guard!)).toBe(true);
    expect(await workspacePrRatchetAccessor.reset(tx, a, guard!)).toBe(false);
  });
  expect(await db.prisma.workspacePRRatchet.findUnique({ where: { prId: a } })).toMatchObject({
    dispatchOutcome: null,
    dispatchRetryCount: 0,
    dispatchStalled: false,
  });
});

it.each(['MERGED', 'CLOSED'] as const)(
  'retains a terminal %s fixer owner for restart cleanup',
  async (state) => {
    const id = `terminal-${state}`;
    const { a } = await setup(id);
    await workspaceRatchetAccessor.recordDispatchIfEnabled(id, {
      prId: a,
      sessionId: 'old',
      snapshotKey: 'old',
      retryCount: 0,
    });
    await db.prisma.workspacePR.update({ where: { id: a }, data: { state } });
    expect(await workspaceRatchetAccessor.findWithPRsForRatchet()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id, prId: a, ratchetActiveSessionId: 'old' }),
      ])
    );
  }
);

it('does not overwrite a dispatch settled while startup was completing', async () => {
  const { a } = await setup('startup-completed');
  await workspaceRatchetAccessor.recordDispatchIfEnabled('startup-completed', {
    prId: a,
    sessionId: 'old',
    snapshotKey: 'old',
    retryCount: 0,
  });
  await workspaceRatchetAccessor.recordSessionEnd('startup-completed', 'old', 'COMPLETED');
  expect(
    await workspaceRatchetAccessor.recordDispatchIfEnabled('startup-completed', {
      prId: a,
      sessionId: 'old',
      snapshotKey: 'old',
      retryCount: 0,
      requireExistingOwnership: true,
    })
  ).toBe(false);
  expect(await db.prisma.workspacePRRatchet.findUnique({ where: { prId: a } })).toMatchObject({
    dispatchOutcome: 'COMPLETED',
  });
});
