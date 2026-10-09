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
function publishedVersion5(exported: Awaited<ReturnType<typeof dataBackupService.exportData>>) {
  return {
    ...exported,
    meta: { ...exported.meta, schemaVersion: 5 },
    data: {
      ...exported.data,
      workspaces: exported.data.workspaces.map((workspace) => {
        const {
          prUrl: _url,
          prNumber: _number,
          prState: _state,
          prReviewState: _review,
          prCiStatus: _ci,
          prUpdatedAt: _updated,
          prCiFailedAt: _failed,
          prCiLastNotifiedAt: _notified,
          prReviewLastCheckedAt: _checked,
          prReviewLastCommentId: _comment,
          ratchetLastCiRunId: _run,
          ratchetState: _ratchet,
          prMonitoring: _monitoring,
          prEvents: _events,
          ...rest
        } = workspace;
        return {
          ...rest,
          ratchetEnabled: true,
          ratchetActiveSessionId: 'fixer-a',
          ratchetActivePrId: 'a',
          prs: workspace.prs.map((pr) => ({
            ...pr,
            ratchet: {
              lastCheckedAt: null,
              activeSessionId: pr.id === 'a' ? 'fixer-a' : null,
              dispatchSnapshotKey: 'legacy-key',
              dispatchOutcome: 'RUNNING',
              dispatchRetryCount: 1,
              dispatchStalled: false,
            },
          })),
        };
      }),
    },
  };
}
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
          },
          {
            id: 'b',
            url: 'https://github.com/other/r/pull/42',
            number: 42,
            state: 'OPEN',
            reviewLastCommentId: 'comment-b',
          },
          {
            id: 'removed',
            url: 'https://github.com/o/r/pull/43',
            state: 'MERGED',
            detachedAt: new Date('2026-10-02'),
            revision: 7,
          },
        ],
      },
    },
  });
  await db.prisma.agentSession.create({
    data: {
      id: 'fixer-a',
      workspaceId: 'w',
      workspacePrId: 'a',
      workflow: 'ratchet',
      model: 'default',
      provider: 'CODEX',
      status: 'COMPLETED',
    },
  });
});
it('normalizes published version 5 PRs, tombstones, discovery, and legacy fixer identity', async () => {
  const exported = await dataBackupService.exportData('test');
  expect(exported.meta.schemaVersion).toBe(6);
  expect(exported.data.workspaces[0]?.prs).toHaveLength(3);
  await clearIntegrationDatabase(db.prisma);
  const normalized = exportDataSchema.parse(publishedVersion5(exported));
  expect(normalized.meta.schemaVersion).toBe(6);
  const imported = await dataBackupService.importData(normalized);
  expect(imported.workspaces.imported).toBe(1);
  const restored = await dataBackupService.exportData('test');
  expect(restored.data.workspaces[0]?.prs).toEqual(exported.data.workspaces[0]?.prs);
  expect(restored.data.workspaces[0]?.prDiscovery).toEqual(
    exported.data.workspaces[0]?.prDiscovery
  );
  expect(restored.data.workspaces[0]?.prMonitoring).toMatchObject({
    recipientSessionId: null,
    deliveryPauseReason: 'LEGACY_FIXER',
    legacySessionIds: ['fixer-a'],
  });
  expect(await db.prisma.agentSession.findUnique({ where: { id: 'fixer-a' } })).toMatchObject({
    workspacePrId: 'a',
    status: 'COMPLETED',
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
      ...publishedVersion5(exported),
      data: {
        ...exported.data,
        workspaces: [
          { ...publishedVersion5(exported).data.workspaces[0]!, ratchetActivePrId: 'foreign' },
        ],
      },
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
it.each(['id', 'url'] as const)('rejects a duplicate PR %s independently', async (field) => {
  const exported = await dataBackupService.exportData('test');
  const workspace = exported.data.workspaces[0]!;
  const prs = workspace.prs.map((pr, index) =>
    index === 1 ? { ...pr, [field]: workspace.prs[0]![field] } : pr
  );
  expect(
    exportDataSchema.safeParse({
      ...exported,
      data: { ...exported.data, workspaces: [{ ...workspace, prs }] },
    }).success
  ).toBe(false);
});
it('retains every legacy fixer identity without restoring operational dispatch ownership', async () => {
  const exported = await dataBackupService.exportData('test');
  const published = publishedVersion5(exported);
  const workspace = published.data.workspaces[0]!;
  workspace.prs[1]!.ratchet.activeSessionId = 'other-legacy-fixer';
  const normalized = exportDataSchema.parse(published);
  expect(normalized.data.workspaces[0]?.prMonitoring).toMatchObject({
    deliveryPauseReason: 'LEGACY_FIXER',
    legacySessionIds: ['fixer-a', 'other-legacy-fixer'],
  });
  expect(normalized.data.workspaces[0]?.prs.every((pr) => !('ratchet' in pr))).toBe(true);
  expect(normalized.data.workspaces[0]?.ratchetActiveSessionId).toBeNull();
});

it('rejects malformed legacy PR URLs without throwing from safeParse', async () => {
  const exported = await dataBackupService.exportData('test');
  const workspace = exported.data.workspaces[0]!;
  expect(
    exportDataSchema.safeParse({
      ...exported,
      meta: { ...exported.meta, schemaVersion: 4 },
      data: {
        ...exported.data,
        workspaces: [{ ...workspace, prUrl: 'invalid-url' }],
        agentSessions: [],
      },
    }).success
  ).toBe(false);
});
it('preserves the PR target of retained sessions in archived workspaces', async () => {
  await db.prisma.workspace.update({ where: { id: 'w' }, data: { status: 'ARCHIVED' } });
  const exported = exportDataSchema.parse(await dataBackupService.exportData('test'));
  await clearIntegrationDatabase(db.prisma);
  await dataBackupService.importData(exported);
  expect(await db.prisma.workspace.findUnique({ where: { id: 'w' } })).toMatchObject({
    status: 'ARCHIVED',
  });
  expect(await db.prisma.agentSession.findUnique({ where: { id: 'fixer-a' } })).toMatchObject({
    workspacePrId: 'a',
  });
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
  expect(
    exportDataSchema.safeParse({
      ...publishedVersion5(exported),
      data: {
        ...exported.data,
        workspaces: [{ ...publishedVersion5(exported).data.workspaces[0]!, ...ownership }],
      },
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
          ratchetActiveSessionId: 'fixer-a',
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

it('roundtrips dedicated mode and PR-session bindings in additive version 6 backups', async () => {
  await db.prisma.agentSession.create({
    data: {
      id: 'dedicated',
      workspaceId: 'w',
      workspacePrId: 'a',
      workflow: 'pr-monitoring',
      provider: 'CLAUDE',
      providerSessionId: 'same-conversation',
    },
  });
  await db.prisma.agentSession.create({
    data: {
      id: 'main-pref',
      workspaceId: 'w',
      workflow: 'implement',
      provider: 'CLAUDE',
      providerSessionId: 'main-pref-provider',
    },
  });
  await db.prisma.workspacePRDedicatedSession.create({ data: { prId: 'b', sessionId: null } });
  await db.prisma.workspacePRDedicatedSession.create({
    data: { prId: 'a', sessionId: 'dedicated' },
  });
  await db.prisma.workspacePRMonitoring.create({
    data: {
      workspaceId: 'w',
      enabled: true,
      deliveryMode: 'DEDICATED',
      recipientSessionId: 'main-pref',
      bindingRevision: 7,
      eventEpoch: 5,
    },
  });
  const exported = await dataBackupService.exportData('test');
  expect(exported.meta.schemaVersion).toBe(6);
  expect(exported.data.workspaces[0]?.prMonitoring).toMatchObject({ deliveryMode: 'DEDICATED' });
  expect(exported.data.workspaces[0]?.prs.find((pr) => pr.id === 'a')).toMatchObject({
    dedicatedSession: { sessionId: 'dedicated' },
  });
  await clearIntegrationDatabase(db.prisma);
  await dataBackupService.importData(exportDataSchema.parse(exported));
  expect(
    await db.prisma.workspacePRDedicatedSession.findUnique({ where: { prId: 'a' } })
  ).toMatchObject({ sessionId: 'dedicated' });
  expect(
    await db.prisma.workspacePRDedicatedSession.findUnique({ where: { prId: 'b' } })
  ).toMatchObject({ sessionId: null });
  expect(await db.prisma.agentSession.findUnique({ where: { id: 'dedicated' } })).toMatchObject({
    providerSessionId: 'same-conversation',
    workflow: 'pr-monitoring',
  });
  expect(
    await db.prisma.workspacePRMonitoring.findUnique({ where: { workspaceId: 'w' } })
  ).toMatchObject({ deliveryMode: 'DEDICATED', bindingRevision: 7, eventEpoch: 5 });
});
it('rejects dedicated backup bindings to a foreign or ordinary session', async () => {
  const exported = await dataBackupService.exportData('test');
  const workspace = exported.data.workspaces[0]!;
  const invalid = {
    ...exported,
    data: {
      ...exported.data,
      workspaces: [
        {
          ...workspace,
          prs: workspace.prs.map((pr) =>
            pr.id === 'a' ? { ...pr, dedicatedSession: { sessionId: 'fixer-a' } } : pr
          ),
        },
      ],
    },
  };
  expect(exportDataSchema.safeParse(invalid).success).toBe(false);
});

it.each([false, true])(
  'rejects empty dedicated backup IDs before writing, including an empty ordinary session: %s',
  async (existing) => {
    const exported = await dataBackupService.exportData('test');
    const workspace = exported.data.workspaces[0]!;
    const invalid = {
      ...exported,
      data: {
        ...exported.data,
        agentSessions: existing
          ? [{ ...exported.data.agentSessions[0]!, id: '', workflow: 'implement' }]
          : [],
        workspaces: [
          {
            ...workspace,
            prs: workspace.prs.map((pr) =>
              pr.id === 'a' ? { ...pr, dedicatedSession: { sessionId: '' } } : pr
            ),
          },
        ],
      },
    };
    expect(exportDataSchema.safeParse(invalid).success).toBe(false);
  }
);

it('rejects and rolls back imported dispatching events without a delivery identity', async () => {
  const exported = await dataBackupService.exportData('test');
  const workspace = exported.data.workspaces[0]!;
  const invalid = {
    ...exported,
    data: {
      ...exported.data,
      workspaces: [
        {
          ...workspace,
          prEvents: [
            {
              id: 'bad-claim',
              workspaceId: 'w',
              prId: null,
              kind: 'MONITORING_ENABLED',
              deduplicationKey: 'bad-claim',
              payload: {
                kind: 'MONITORING_ENABLED' as const,
                workspaceId: 'w',
                bindingRevision: 0,
                replyToPrComments: false,
              },
              state: 'DISPATCHING' as const,
              attempts: 1,
              deliveryId: null,
              deliverySessionId: 'fixer-a',
              deliveryBindingRevision: 0,
              deliveryText: 'frozen',
              claimedAt: null,
              deliveredAt: null,
              createdAt: '2026-10-08T00:00:00.000Z',
            },
          ],
        },
      ],
    },
  };
  expect(exportDataSchema.safeParse(invalid).success).toBe(false);
  await clearIntegrationDatabase(db.prisma);
  await expect(dataBackupService.importData(invalid)).rejects.toThrow(
    'complete frozen delivery metadata'
  );
  expect(await db.prisma.workspacePREvent.count()).toBe(0);
  expect(await db.prisma.workspace.count()).toBe(0);
  expect(await db.prisma.project.count()).toBe(0);
});
