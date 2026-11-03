import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { sessionDataService } from '@/backend/services/session';
import { workspaceDataService } from '@/backend/services/workspace';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { Prisma, PrismaClient } from '@prisma-gen/client';
import { dataBackupAccessor } from './data-backup.accessor';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!state.prisma) {
      throw new Error('Missing database');
    }
    return state.prisma;
  },
}));

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
}, 30_000);
beforeEach(async () => {
  await clearIntegrationDatabase(db.prisma);
  await db.prisma.project.create({
    data: {
      id: 'local-project',
      slug: 'local-slug',
      name: 'Local project',
      repoPath: '/local/repo',
      worktreeBasePath: '/local/worktrees',
      githubOwner: 'local-owner',
      githubRepo: 'local-repo',
      issueTrackerConfig: { linear: { apiKey: 'must-not-be-projected' } },
    },
  });
  for (const id of ['local-workspace', 'other-workspace']) {
    await db.prisma.workspace.create({
      data: { id, projectId: 'local-project', name: id },
    });
  }
  await db.prisma.workspacePR.create({
    data: { id: 'local-pr', workspaceId: 'local-workspace', url: 'https://github.com/o/r/pull/1' },
  });
  await db.prisma.agentSession.create({
    data: {
      id: 'local-session',
      workspaceId: 'local-workspace',
      workspacePrId: 'local-pr',
      workflow: 'pr-monitoring',
      model: 'default',
      status: 'RUNNING',
      provider: 'CLAUDE',
      providerProcessPid: 543_210,
    },
  });
  await db.prisma.workspacePRDedicatedSession.create({
    data: { prId: 'local-pr', sessionId: 'local-session' },
  });
});
afterAll(async () => destroyIntegrationDatabase(db));

const candidate = (id: string, workspaceId = 'incoming-workspace') => ({
  id,
  workspaceId,
  prId: null as string | null,
  deduplicationKey: `key-${id}`,
  deliveryId: null as string | null,
});

function retainedRows(tx: Prisma.TransactionClient) {
  return Promise.all([
    tx.project.findMany({ orderBy: { id: 'asc' } }),
    tx.workspace.findMany({ orderBy: { id: 'asc' } }),
    tx.workspacePR.findMany({ orderBy: { id: 'asc' } }),
    tx.workspacePREvent.findMany({ orderBy: { id: 'asc' } }),
    tx.workspacePRDelivery.findMany({ orderBy: { id: 'asc' } }),
    tx.agentSession.findMany({ orderBy: { id: 'asc' } }),
    tx.workspacePRDedicatedSession.findMany({ orderBy: { prId: 'asc' } }),
  ]);
}

function seedEvent(
  fields: Pick<Prisma.WorkspacePREventUncheckedCreateInput, 'id'> &
    Partial<Prisma.WorkspacePREventUncheckedCreateInput>
) {
  return db.prisma.workspacePREvent.create({
    data: {
      workspaceId: 'local-workspace',
      kind: 'MONITORING_ENABLED',
      payload: { kind: 'MONITORING_ENABLED' },
      deduplicationKey: `key-${fields.id}`,
      ...fields,
    },
  });
}

it('reads identities and session IDs from uncommitted private transaction rows without changing them', async () => {
  const before = await retainedRows(db.prisma);
  await expect(
    dataBackupAccessor.runInTransaction(async (tx) => {
      await tx.workspace.create({
        data: { id: 'private-workspace', projectId: 'local-project', name: 'Uncommitted' },
      });
      await tx.agentSession.create({
        data: {
          id: 'private-session',
          workspaceId: 'private-workspace',
          model: 'default',
          workflow: 'implement',
          provider: 'CLAUDE',
        },
      });
      const privateBefore = await retainedRows(tx);
      expect(
        await workspaceDataService.readBackupIdentities(tx, {
          projects: [
            { id: 'local-project', slug: 'incoming-slug' },
            { id: 'incoming-project', slug: 'local-slug' },
          ],
          workspaceIds: ['private-workspace', 'local-workspace', 'missing-workspace'],
          prIds: ['local-pr', 'missing-pr'],
        })
      ).toEqual({
        projects: [
          {
            id: 'local-project',
            slug: 'local-slug',
            repoPath: '/local/repo',
            worktreeBasePath: '/local/worktrees',
            githubOwner: 'local-owner',
            githubRepo: 'local-repo',
          },
        ],
        workspaceIds: new Set(['local-workspace', 'private-workspace']),
        prIds: new Set(['local-pr']),
      });
      expect(
        await sessionDataService.findExistingBackupSessionIds(tx, [
          'local-session',
          'private-session',
          'missing-session',
          'local-session',
        ])
      ).toEqual(new Set(['local-session', 'private-session']));
      expect(await retainedRows(tx)).toEqual(privateBefore);
      throw new Error('Rollback fixture rows');
    })
  ).rejects.toThrow('Rollback fixture rows');
  expect(await retainedRows(db.prisma)).toEqual(before);
});

it.each([
  { id: 'local-project', slug: 'missing-slug' },
  { id: 'missing-project', slug: 'local-slug' },
])('reads project identity independently by ID or slug: $id/$slug', async (project) => {
  await dataBackupAccessor.runInTransaction(async (tx) => {
    const result = await workspaceDataService.readBackupIdentities(tx, {
      projects: [project],
      workspaceIds: [],
      prIds: [],
    });
    expect(result.projects).toEqual([
      {
        id: 'local-project',
        slug: 'local-slug',
        repoPath: '/local/repo',
        worktreeBasePath: '/local/worktrees',
        githubOwner: 'local-owner',
        githubRepo: 'local-repo',
      },
    ]);
  });
});

it('reads existing session IDs without borrowing or changing their dedicated binding', async () => {
  const before = await retainedRows(db.prisma);
  await dataBackupAccessor.runInTransaction(async (tx) => {
    expect(
      await sessionDataService.findExistingBackupSessionIds(tx, ['local-session', 'missing'])
    ).toEqual(new Set(['local-session']));
  });
  expect(await retainedRows(db.prisma)).toEqual(before);
});

it('maps raw, normalized-only and batch receipt references to every referring incoming workspace', async () => {
  await seedEvent({ id: 'raw-member', deliveryId: 'raw-only', attempts: 3, deliveryText: 'raw' });
  await db.prisma.workspacePRDelivery.createMany({
    data: [
      { id: 'normalized-only', workspaceId: 'local-workspace', eventIds: [], state: 'BLOCKED' },
      {
        id: 'batch-only',
        workspaceId: 'local-workspace',
        eventIds: ['batch-member'],
        state: 'BLOCKED',
      },
    ],
  });
  await seedEvent({ id: 'batch-member', batchId: 'batch-only' });
  // Deliberately damaged retained evidence: no normalized row, but the raw batch reference remains.
  await db.prisma.$executeRawUnsafe('PRAGMA foreign_keys = OFF');
  try {
    await seedEvent({ id: 'orphan-batch-member', batchId: 'orphan-batch' });
  } finally {
    await db.prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON');
  }
  const before = await retainedRows(db.prisma);
  await expect(
    dataBackupAccessor.runInTransaction(async (tx) => {
      await tx.workspacePREvent.create({
        data: {
          id: 'private-event',
          workspaceId: 'local-workspace',
          kind: 'MONITORING_ENABLED',
          payload: {},
          deduplicationKey: 'private-key',
        },
      });
      const privateBefore = await retainedRows(tx);
      const events = [
        { ...candidate('incoming-raw-a', 'raw-a'), deliveryId: 'raw-only' },
        { ...candidate('incoming-raw-b', 'raw-b'), deliveryId: 'raw-only' },
        { ...candidate('incoming-normalized', 'normalized'), deliveryId: 'normalized-only' },
        { ...candidate('incoming-batch', 'batch'), deliveryId: 'batch-only' },
        { ...candidate('incoming-orphan-batch', 'orphan'), deliveryId: 'orphan-batch' },
        candidate('private-event', 'private'),
        candidate('healthy'),
      ];
      expect(await workspaceDataService.findBackupEventConflicts(tx, events)).toEqual(
        new Set(['raw-a', 'raw-b', 'normalized', 'batch', 'orphan', 'private'])
      );
      expect(await retainedRows(tx)).toEqual(privateBefore);
      throw new Error('Rollback private event');
    })
  ).rejects.toThrow('Rollback private event');
  expect(await retainedRows(db.prisma)).toEqual(before);
});

it('checks both exact deduplication keys with SQLite null semantics and unambiguous tuple keys', async () => {
  await seedEvent({ id: 'workspace-key', deduplicationKey: 'shared-key' });
  await seedEvent({ id: 'pr-key', prId: 'local-pr', deduplicationKey: 'pr-shared-key' });
  await seedEvent({ id: 'delimiter-key', workspaceId: 'other-workspace', deduplicationKey: 'a:b' });
  await dataBackupAccessor.runInTransaction(async (tx) => {
    expect(
      await workspaceDataService.findBackupEventConflicts(tx, [
        { ...candidate('new-workspace-key', 'local-workspace'), deduplicationKey: 'shared-key' },
        {
          ...candidate('new-pr-key', 'foreign-pr-group'),
          prId: 'local-pr',
          deduplicationKey: 'pr-shared-key',
        },
        { ...candidate('null-is-not-global', 'other-workspace'), deduplicationKey: 'shared-key' },
        { ...candidate('tuple-must-not-merge', 'other-workspace:a'), deduplicationKey: 'b' },
        candidate('workspace-key', 'same-id-a'),
        candidate('workspace-key', 'same-id-b'),
      ])
    ).toEqual(new Set(['local-workspace', 'foreign-pr-group', 'same-id-a', 'same-id-b']));
  });
});

function whereValues(value: unknown): number {
  if (typeof value === 'string') {
    return 1;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, member) => sum + whereValues(member), 0);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).reduce<number>((sum, member) => sum + whereValues(member), 0);
  }
  return 0;
}

it('bounds every query beyond 1,000 candidate identities and maps late receipt hits across chunks', async () => {
  await seedEvent({ id: 'local-event', deliveryId: 'late-receipt' });
  await dataBackupAccessor.runInTransaction(async (tx) => {
    const spies = [
      vi.spyOn(tx.project, 'findMany'),
      vi.spyOn(tx.workspace, 'findMany'),
      vi.spyOn(tx.workspacePR, 'findMany'),
      vi.spyOn(tx.workspacePREvent, 'findMany'),
      vi.spyOn(tx.workspacePRDelivery, 'findMany'),
      vi.spyOn(tx.agentSession, 'findMany'),
    ];
    const ids = Array.from({ length: 1005 }, (_, index) => `missing-${index}`);
    const identity = await workspaceDataService.readBackupIdentities(tx, {
      projects: [
        ...ids.map((id) => ({ id, slug: id })),
        { id: 'late-project', slug: 'local-slug' },
      ],
      workspaceIds: ['local-workspace', ...ids, 'other-workspace'],
      prIds: [...ids, 'local-pr'],
    });
    expect(identity.projects).toHaveLength(1);
    expect(identity.projects[0]?.id).toBe('local-project');
    expect(identity.workspaceIds).toEqual(new Set(['local-workspace', 'other-workspace']));
    expect(identity.prIds).toEqual(new Set(['local-pr']));
    expect(
      await sessionDataService.findExistingBackupSessionIds(tx, [...ids, 'local-session'])
    ).toEqual(new Set(['local-session']));
    const events = ids.map((id) => ({
      ...candidate(id, id),
      prId: `pr-${id}`,
      deliveryId: `receipt-${id}`,
    }));
    events[0] = {
      ...candidate('local-event', 'early-group'),
      prId: 'early-pr',
      deliveryId: 'new-early-receipt',
    };
    events.push(
      { ...candidate('late-a', 'late-group-a'), prId: 'pr-a', deliveryId: 'late-receipt' },
      { ...candidate('late-b', 'late-group-b'), prId: 'pr-b', deliveryId: 'late-receipt' }
    );
    expect(await workspaceDataService.findBackupEventConflicts(tx, events)).toEqual(
      new Set(['early-group', 'late-group-a', 'late-group-b'])
    );
    for (const spy of spies) {
      expect(spy).toHaveBeenCalled();
      for (const [args] of spy.mock.calls) {
        expect(whereValues(args?.where)).toBeLessThanOrEqual(700);
      }
    }
  });
});

it('returns empty collision sets without issuing a query for empty candidates', async () => {
  await dataBackupAccessor.runInTransaction(async (tx) => {
    const spies = [
      vi.spyOn(tx.project, 'findMany'),
      vi.spyOn(tx.workspace, 'findMany'),
      vi.spyOn(tx.workspacePR, 'findMany'),
      vi.spyOn(tx.workspacePREvent, 'findMany'),
      vi.spyOn(tx.workspacePRDelivery, 'findMany'),
      vi.spyOn(tx.agentSession, 'findMany'),
    ];
    expect(
      await workspaceDataService.readBackupIdentities(tx, {
        projects: [],
        workspaceIds: [],
        prIds: [],
      })
    ).toEqual({
      projects: [],
      workspaceIds: new Set(),
      prIds: new Set(),
    });
    expect(await workspaceDataService.findBackupEventConflicts(tx, [])).toEqual(new Set());
    expect(await sessionDataService.findExistingBackupSessionIds(tx, [])).toEqual(new Set());
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
