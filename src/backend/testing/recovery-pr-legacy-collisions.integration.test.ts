import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import { configService } from '@/backend/services/config.service';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import type { PrismaClient } from '@prisma-gen/client';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from './integration-db';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!database.prisma) {
      throw new Error('Missing test DB');
    }
    return database.prisma;
  },
}));
let db: IntegrationDatabase;
beforeEach(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
  vi.spyOn(configService, 'getBaseDir').mockReturnValue(db.tempDir);
  await projectAndWorkspace('source');
}, 30_000);
afterEach(async () => destroyIntegrationDatabase(db));

async function projectAndWorkspace(id: string) {
  await db.prisma.project.create({
    data: { id, name: id, slug: id, repoPath: `/${id}`, worktreeBasePath: `/${id}-trees` },
  });
  await db.prisma.workspace.create({ data: { id, projectId: id, name: id } });
}
async function event(id: string, workspaceId: string) {
  return await db.prisma.workspacePREvent.create({
    data: {
      id,
      workspaceId,
      kind: 'MONITORING_ENABLED',
      deduplicationKey: id,
      state: 'PENDING',
      payload: {
        kind: 'MONITORING_ENABLED',
        workspaceId,
        bindingRevision: 1,
        replyToPrComments: true,
      },
    },
  });
}
async function legacyGroup(workspaceId: string, receipt: string, complete = true) {
  for (const [index, suffix] of ['first', 'second'].entries()) {
    const row = await event(`${workspaceId}-${suffix}`, workspaceId);
    await db.prisma.workspacePREvent.update({
      where: { id: row.id },
      data: {
        deliveryId: receipt,
        state: complete ? 'DISPATCHING' : 'PENDING',
        attempts: 2,
        deliverySessionId: complete ? `${workspaceId}-session` : null,
        deliveryProvider: complete ? 'CODEX' : null,
        deliveryProviderSessionId: complete ? `${workspaceId}-native` : null,
        deliveryBindingRevision: complete ? 1 : null,
        deliveryText: complete ? `${workspaceId} frozen text` : null,
        claimedAt: complete ? new Date('2026-01-01T00:01:00.000Z') : null,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      },
    });
  }
}
async function sourceBackup(format: 'normalized' | 'legacy' | 'v6' | 'v7') {
  if (format !== 'normalized') {
    await legacyGroup('source', 'receipt');
  } else {
    await db.prisma.workspacePRDelivery.create({
      data: {
        id: 'receipt',
        workspaceId: 'source',
        eventIds: ['source-first', 'source-second'],
        state: 'DISPATCHING',
        text: 'source frozen text',
        provider: 'CODEX',
        providerSessionId: 'source-native',
        sessionId: 'source-session',
        bindingRevision: 1,
      },
    });
    for (const suffix of ['first', 'second']) {
      const row = await event(`source-${suffix}`, 'source');
      await db.prisma.workspacePREvent.update({
        where: { id: row.id },
        data: { batchId: 'receipt' },
      });
    }
  }
  await event('independent', 'source');
  const backup = await dataBackupService.exportData('test');
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  if (format === 'v6' || format === 'v7') {
    return exportDataSchema.parse(
      JSON.parse(
        JSON.stringify({
          ...backup,
          meta: { ...backup.meta, schemaVersion: format === 'v6' ? 6 : 7, recovery: undefined },
          data: {
            ...backup.data,
            durable: undefined,
            archives: undefined,
            workspaces: backup.data.workspaces.map((workspace) => ({
              ...workspace,
              prRecovery: undefined,
              prEvents: workspace.prRecovery!.events.map(
                ({ batchId: _batchId, ...event }) => event
              ),
            })),
          },
        })
      )
    );
  }
  return backup;
}

it.each(
  (['normalized', 'legacy', 'v6', 'v7'] as const).flatMap((format) =>
    [false, true].map((complete) => ({ format, complete }))
  )
)(
  'skips an entire $format effect when destination legacy evidence owns its receipt (complete=$complete)',
  async ({ format, complete }) => {
    const backup = await sourceBackup(format);
    await projectAndWorkspace('local');
    await legacyGroup('local', 'receipt', complete);
    const localEvents = await db.prisma.workspacePREvent.findMany({
      where: { workspaceId: 'local' },
      orderBy: { id: 'asc' },
    });
    const localDeliveries = await db.prisma.workspacePRDelivery.findMany();
    expect(localEvents).toHaveLength(2);
    expect(localEvents.every((row) => row.batchId === null && row.deliveryId === 'receipt')).toBe(
      true
    );

    const result = await dataBackupService.importData(backup);

    expect(
      await db.prisma.workspacePREvent.findMany({
        where: { workspaceId: 'local' },
        orderBy: { id: 'asc' },
      })
    ).toEqual(localEvents);
    expect(await db.prisma.workspacePRDelivery.findMany()).toEqual(localDeliveries);
    expect(await db.prisma.workspacePREvent.findMany({ where: { workspaceId: 'source' } })).toEqual(
      [
        expect.objectContaining({
          id: 'independent',
          state: 'CANCELLED',
          batchId: null,
          deliveryId: null,
        }),
      ]
    );
    expect(result.recovery.models).toContainEqual({
      model: 'WorkspacePREvent',
      imported: 1,
      skipped: 2,
    });
    expect(result.recovery.skipped).toEqual(
      expect.arrayContaining([
        {
          model: 'WorkspacePREvent',
          identity: 'source-first',
          reason: 'CONFLICTING_IDENTITY_OR_PARENT',
        },
        {
          model: 'WorkspacePREvent',
          identity: 'source-second',
          reason: 'CONFLICTING_IDENTITY_OR_PARENT',
        },
        ...(format === 'normalized'
          ? [
              {
                model: 'WorkspacePRDelivery',
                identity: 'receipt',
                reason: 'CONFLICTING_IDENTITY_OR_PARENT',
              },
            ]
          : []),
      ])
    );
  }
);

it('normalizes an uncontended legacy effect in order while preserving unrelated local legacy evidence', async () => {
  const backup = await sourceBackup('legacy');
  await projectAndWorkspace('local');
  await legacyGroup('local', 'unrelated-local-receipt');
  const localEvents = await db.prisma.workspacePREvent.findMany({
    where: { workspaceId: 'local' },
    orderBy: { id: 'asc' },
  });
  const result = await dataBackupService.importData(backup);
  expect(
    await db.prisma.workspacePREvent.findMany({
      where: { workspaceId: 'local' },
      orderBy: { id: 'asc' },
    })
  ).toEqual(localEvents);
  expect(
    await db.prisma.workspacePRDelivery.findUnique({ where: { id: 'receipt' } })
  ).toMatchObject({
    workspaceId: 'source',
    eventIds: ['source-first', 'source-second'],
    state: 'BLOCKED',
    text: 'source frozen text',
    provider: 'CODEX',
    providerSessionId: 'source-native',
    sessionId: 'source-session',
    bindingRevision: 1,
    attempts: 2,
  });
  expect(
    await db.prisma.workspacePREvent.findMany({
      where: { workspaceId: 'source', batchId: 'receipt' },
      orderBy: { id: 'asc' },
    })
  ).toEqual([
    expect.objectContaining({ id: 'source-first' }),
    expect.objectContaining({ id: 'source-second' }),
  ]);
  expect(result.recovery.models).toContainEqual({
    model: 'WorkspacePREvent',
    imported: 3,
    skipped: 0,
  });
});
