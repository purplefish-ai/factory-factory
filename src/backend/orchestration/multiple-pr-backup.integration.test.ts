import type { PrismaClient } from '@prisma-gen/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import { dataBackupService } from './data-backup.service';

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
beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
}, 30_000);
afterAll(async () => destroyIntegrationDatabase(db));
beforeEach(async () => {
  await clearIntegrationDatabase(db.prisma);
  await db.prisma.project.create({
    data: { id: 'p', name: 'P', slug: 'p', repoPath: '/tmp/p', worktreeBasePath: '/tmp/w' },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'w',
      projectId: 'p',
      name: 'W',
      status: 'READY',
      ratchet: { create: {} },
      runScript: { create: {} },
      autoIteration: { create: {} },
      prDiscovery: { create: { retryCount: 4, nextCheckAt: new Date('2026-11-01') } },
      prs: {
        create: [
          {
            id: 'a',
            url: 'https://github.com/o/r/pull/42',
            number: 42,
            state: 'OPEN',
            ciStatus: 'FAILURE',
            ciFailedAt: new Date('2026-10-01'),
            reviewLastCommentId: 'comment-a',
            automation: {
              create: {
                activeSessionId: 'fixer-a',
                dispatchSnapshotKey: 'a-key',
                dispatchOutcome: 'RUNNING',
                dispatchRetryCount: 1,
              },
            },
          },
          {
            id: 'b',
            url: 'https://github.com/other/r/pull/42',
            number: 42,
            state: 'OPEN',
            reviewLastCommentId: 'comment-b',
            automation: {
              create: {
                dispatchSnapshotKey: 'b-key',
                dispatchOutcome: 'DIED',
                dispatchRetryCount: 3,
                dispatchStalled: true,
              },
            },
          },
          {
            id: 'removed',
            url: 'https://github.com/o/r/pull/43',
            state: 'MERGED',
            detachedAt: new Date('2026-10-02'),
            revision: 7,
            automation: { create: { dispatchOutcome: 'COMPLETED' } },
          },
        ],
      },
    },
  });
  await db.prisma.workspaceRatchet.update({
    where: { workspaceId: 'w' },
    data: { activePrId: 'a', activeSessionId: 'fixer-a' },
  });
  await db.prisma.agentSession.create({
    data: {
      id: 'fixer-a',
      workspaceId: 'w',
      workspacePrId: 'a',
      workflow: 'ratchet',
      model: 'default',
      provider: 'CODEX',
    },
  });
});
it('round-trips independent PR history, tombstones, discovery, and exact fixer ownership', async () => {
  const exported = await dataBackupService.exportData('test');
  expect(exported.meta.schemaVersion).toBe(5);
  expect(exported.data.workspaces[0]?.prs).toHaveLength(3);
  await clearIntegrationDatabase(db.prisma);
  const imported = await dataBackupService.importData(exportDataSchema.parse(exported));
  expect(imported.workspaces.imported).toBe(1);
  const restored = await dataBackupService.exportData('test');
  expect(restored.data).toEqual(exported.data);
  expect(
    await db.prisma.workspaceRatchet.findUnique({ where: { workspaceId: 'w' } })
  ).toMatchObject({ activePrId: 'a', activeSessionId: 'fixer-a' });
  expect(await db.prisma.agentSession.findUnique({ where: { id: 'fixer-a' } })).toMatchObject({
    workspacePrId: 'a',
  });
});
it('rejects duplicate and foreign ownership before any database write', async () => {
  const exported = await dataBackupService.exportData('test');
  const w = exported.data.workspaces[0]!;
  expect(
    exportDataSchema.safeParse({
      ...exported,
      data: { ...exported.data, workspaces: [{ ...w, prs: [...w.prs, w.prs[0]!] }] },
    }).success
  ).toBe(false);
  expect(
    exportDataSchema.safeParse({
      ...exported,
      data: { ...exported.data, workspaces: [{ ...w, ratchetActivePrId: 'foreign' }] },
    }).success
  ).toBe(false);
  expect(
    exportDataSchema.safeParse({
      ...exported,
      data: {
        ...exported.data,
        agentSessions: [{ ...exported.data.agentSessions[0]!, workspacePrId: 'foreign' }],
      },
    }).success
  ).toBe(false);
});
it('imports a version 4 workspace without inventing an empty PR association', async () => {
  const exported = await dataBackupService.exportData('test');
  const w = exported.data.workspaces[0]!;
  const legacy = {
    ...w,
    id: 'no-pr',
    ratchetActiveSessionId: null,
    prUrl: null,
    prNumber: null,
    prState: 'NONE',
    prReviewState: null,
    prCiStatus: 'UNKNOWN',
    prUpdatedAt: null,
    prCiFailedAt: null,
    prCiLastNotifiedAt: null,
    prReviewLastCheckedAt: null,
    prReviewLastCommentId: null,
    ratchetState: 'IDLE',
    ratchetLastCiRunId: null,
  };
  const normalized = exportDataSchema.parse({
    ...exported,
    meta: { ...exported.meta, schemaVersion: 4 },
    data: { ...exported.data, workspaces: [legacy], agentSessions: [], terminalSessions: [] },
  });
  expect(normalized.data.workspaces[0]?.prs).toEqual([]);
  const result = await dataBackupService.importData(normalized);
  expect(result.workspaces.imported).toBe(1);
  expect(await db.prisma.workspacePR.count({ where: { workspaceId: 'no-pr' } })).toBe(0);
  expect(
    await db.prisma.workspacePRDiscovery.findUnique({ where: { workspaceId: 'no-pr' } })
  ).not.toBeNull();
});

it.each([
  { ratchetActivePrId: null, ratchetActiveSessionId: 'fixer-a' },
  { ratchetActivePrId: 'a', ratchetActiveSessionId: null },
])('rejects incomplete active fixer ownership: %j', async (ownership) => {
  const exported = await dataBackupService.exportData('test');
  const workspace = exported.data.workspaces[0]!;
  expect(
    exportDataSchema.safeParse({
      ...exported,
      data: { ...exported.data, workspaces: [{ ...workspace, ...ownership }] },
    }).success
  ).toBe(false);
});

it('backfills only the matching legacy fixer session PR target', async () => {
  const exported = await dataBackupService.exportData('test');
  const workspace = exported.data.workspaces[0]!;
  const fixer = exported.data.agentSessions[0]!;
  const normalized = exportDataSchema.parse({
    ...exported,
    meta: { ...exported.meta, schemaVersion: 4 },
    data: {
      ...exported.data,
      workspaces: [
        {
          ...workspace,
          prUrl: 'https://github.com/o/r/pull/42',
          prNumber: 42,
          prState: 'OPEN',
          prReviewState: null,
          prCiStatus: 'FAILURE',
          prUpdatedAt: null,
          prCiFailedAt: null,
          prCiLastNotifiedAt: null,
          prReviewLastCheckedAt: null,
          prReviewLastCommentId: null,
          ratchetState: 'CI_FAILED',
          ratchetLastCiRunId: 'a-key',
        },
      ],
      agentSessions: [
        { ...fixer, workspacePrId: null },
        { ...fixer, id: 'unrelated', workspacePrId: null },
      ],
    },
  });
  expect(normalized.data.agentSessions.map((s) => s.workspacePrId)).toEqual(['legacy-pr-w', null]);
  await clearIntegrationDatabase(db.prisma);
  await dataBackupService.importData(normalized);
  expect(await db.prisma.agentSession.findUnique({ where: { id: 'fixer-a' } })).toMatchObject({
    workspacePrId: 'legacy-pr-w',
  });
});

it.each(['missing', 'foreign', 'matching'] as const)(
  'validates %s local PR association when skipping an existing workspace',
  async (association) => {
    const exported = await dataBackupService.exportData('test');
    await clearIntegrationDatabase(db.prisma);
    await db.prisma.project.create({
      data: { id: 'p', name: 'P', slug: 'p', repoPath: '/tmp/p', worktreeBasePath: '/tmp/w' },
    });
    await db.prisma.workspace.create({ data: { id: 'w', projectId: 'p', name: 'Local W' } });
    if (association !== 'missing') {
      const workspaceId = association === 'matching' ? 'w' : 'other';
      if (workspaceId === 'other') {
        await db.prisma.workspace.create({ data: { id: 'other', projectId: 'p', name: 'Other' } });
      }
      await db.prisma.workspacePR.create({
        data: { id: 'a', workspaceId, url: 'https://github.com/o/r/pull/42' },
      });
    }
    const result = await dataBackupService.importData(exportDataSchema.parse(exported));
    expect(result.workspaces).toEqual({ imported: 0, skipped: 1 });
    expect(result.agentSessions).toEqual(
      association === 'matching' ? { imported: 1, skipped: 0 } : { imported: 0, skipped: 1 }
    );
    expect(await db.prisma.agentSession.count()).toBe(association === 'matching' ? 1 : 0);
  }
);
