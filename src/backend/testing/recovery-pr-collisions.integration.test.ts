import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import { configService } from '@/backend/services/config.service';
import { type PrismaClient } from '@prisma-gen/client';
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
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Recovery',
      slug: 'recovery',
      repoPath: '/test',
      worktreeBasePath: '/test-trees',
    },
  });
  await db.prisma.workspace.create({
    data: { id: 'workspace', projectId: 'project', name: 'Recovery' },
  });
  await db.prisma.agentSession.create({
    data: {
      id: 'session',
      workspaceId: 'workspace',
      workflow: 'default',
      model: 'default',
      provider: 'CODEX',
    },
  });
}, 30_000);
afterEach(async () => {
  await destroyIntegrationDatabase(db);
});

async function clear() {
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
}
async function localWorkspace() {
  await db.prisma.project.create({
    data: {
      id: 'local-project',
      name: 'Local',
      slug: 'local',
      repoPath: '/local',
      worktreeBasePath: '/local-trees',
    },
  });
  await db.prisma.workspace.create({
    data: { id: 'local-workspace', projectId: 'local-project', name: 'Local' },
  });
}
function fact(
  id: string,
  workspaceId: string,
  batchId: string | null = null,
  deduplicationKey = id
) {
  return db.prisma.workspacePREvent.create({
    data: {
      id,
      workspaceId,
      batchId,
      kind: 'MONITORING_ENABLED',
      deduplicationKey,
      payload: {
        kind: 'MONITORING_ENABLED',
        workspaceId,
        bindingRevision: 1,
        replyToPrComments: true,
      },
      state: 'PENDING',
    },
  });
}
it.each(['delivery', 'member'] as const)(
  'skips the whole frozen batch on a %s identity collision and reports every member',
  async (collision) => {
    await db.prisma.workspacePRDelivery.create({
      data: {
        id: 'receipt',
        workspaceId: 'workspace',
        eventIds: ['second', 'first'],
        state: 'DISPATCHING',
        text: 'exact original',
        provider: 'CODEX',
        providerSessionId: 'native',
        sessionId: 'session',
        bindingRevision: 1,
      },
    });
    await fact('first', 'workspace', 'receipt');
    await fact('second', 'workspace', 'receipt');
    await fact('unrelated', 'workspace');
    const backup = await dataBackupService.exportData('test');
    await clear();
    await localWorkspace();
    const localDelivery = await db.prisma.workspacePRDelivery.create({
      data: {
        id: collision === 'delivery' ? 'receipt' : 'local-receipt',
        workspaceId: 'local-workspace',
        eventIds: [collision === 'member' ? 'first' : 'local-member'],
        state: 'DELIVERED',
        text: 'keep exact local proof',
      },
    });
    const localFact = await fact(
      collision === 'member' ? 'first' : 'local-member',
      'local-workspace',
      localDelivery.id
    );
    const result = await dataBackupService.importData(backup);
    expect(result.projects.imported).toBe(1);
    expect(
      await db.prisma.workspacePRDelivery.findUnique({ where: { id: localDelivery.id } })
    ).toEqual(localDelivery);
    expect(await db.prisma.workspacePREvent.findUnique({ where: { id: localFact.id } })).toEqual(
      localFact
    );
    expect(await db.prisma.workspacePRDelivery.count({ where: { workspaceId: 'workspace' } })).toBe(
      0
    );
    expect(
      await db.prisma.workspacePREvent.findMany({ where: { workspaceId: 'workspace' } })
    ).toEqual([expect.objectContaining({ id: 'unrelated', state: 'CANCELLED' })]);
    expect(result.recovery.models).toContainEqual({
      model: 'WorkspacePRDelivery',
      imported: 0,
      skipped: 1,
    });
    expect(result.recovery.models).toContainEqual({
      model: 'WorkspacePREvent',
      imported: 1,
      skipped: 2,
    });
    expect(
      result.recovery.skipped
        .filter((row) => row.model === 'WorkspacePREvent')
        .map((row) => row.identity)
        .sort()
    ).toEqual(['first', 'second']);
  }
);
it('reports a dedicated PR binding skipped because its source session collided with another local workspace', async () => {
  await db.prisma.workspacePR.create({
    data: { id: 'pr', workspaceId: 'workspace', url: 'https://github.com/owner/repo/pull/1' },
  });
  await db.prisma.agentSession.update({
    where: { id: 'session' },
    data: { workspacePrId: 'pr', workflow: 'pr-monitoring' },
  });
  await db.prisma.workspacePRDedicatedSession.create({
    data: { prId: 'pr', sessionId: 'session' },
  });
  const backup = await dataBackupService.exportData('test');
  await clear();
  await localWorkspace();
  const local = await db.prisma.agentSession.create({
    data: { id: 'session', workspaceId: 'local-workspace', provider: 'CODEX', workflow: 'default' },
  });
  const result = await dataBackupService.importData(backup);
  expect(await db.prisma.agentSession.findUnique({ where: { id: 'session' } })).toEqual(local);
  expect(
    await db.prisma.workspacePRDedicatedSession.findUnique({ where: { prId: 'pr' } })
  ).toBeNull();
  expect(result.recovery.skipped).toContainEqual({
    model: 'WorkspacePRDedicatedSession',
    identity: 'pr',
    reason: 'CONFLICTING_IDENTITY_OR_PARENT',
  });
});
it('skips a colliding PR association and its dedicated binding without borrowing foreign ownership', async () => {
  await db.prisma.workspacePR.create({
    data: { id: 'pr', workspaceId: 'workspace', url: 'https://github.com/owner/repo/pull/1' },
  });
  await db.prisma.workspacePRDedicatedSession.create({ data: { prId: 'pr', sessionId: null } });
  const backup = await dataBackupService.exportData('test');
  await clear();
  await localWorkspace();
  const local = await db.prisma.workspacePR.create({
    data: { id: 'pr', workspaceId: 'local-workspace', url: 'https://github.com/other/repo/pull/9' },
  });
  const result = await dataBackupService.importData(backup);
  expect(await db.prisma.workspacePR.findUnique({ where: { id: 'pr' } })).toEqual(local);
  expect(await db.prisma.workspacePRDedicatedSession.count()).toBe(0);
  expect(result.recovery.skipped).toContainEqual({
    model: 'WorkspacePR',
    identity: 'pr',
    reason: 'EXISTING_IDENTITY',
  });
  expect(result.recovery.skipped).toContainEqual({
    model: 'WorkspacePRDedicatedSession',
    identity: 'pr',
    reason: 'CONFLICTING_IDENTITY_OR_PARENT',
  });
});
it('skips an internally conflicting frozen batch while retaining an independent unbatched fact', async () => {
  await db.prisma.workspacePRDelivery.create({
    data: {
      id: 'receipt',
      workspaceId: 'workspace',
      eventIds: ['first', 'second'],
      state: 'DELIVERED',
      text: 'frozen',
    },
  });
  await fact('first', 'workspace', 'receipt');
  await fact('second', 'workspace', 'receipt');
  await fact('independent', 'workspace');
  const backup = await dataBackupService.exportData('test');
  const recovery = backup.data.workspaces[0]!.prRecovery!;
  recovery.events.find((row) => row.id === 'second')!.deduplicationKey = 'first';
  await clear();
  const result = await dataBackupService.importData(backup);
  expect(await db.prisma.workspacePRDelivery.count()).toBe(0);
  expect(await db.prisma.workspacePREvent.findMany()).toEqual([
    expect.objectContaining({ id: 'independent' }),
  ]);
  expect(result.recovery.models).toContainEqual({
    model: 'WorkspacePRDelivery',
    imported: 0,
    skipped: 1,
  });
  expect(result.recovery.models).toContainEqual({
    model: 'WorkspacePREvent',
    imported: 1,
    skipped: 2,
  });
});
it('skips a conflicting unbatched fact without dropping a complete ordered frozen batch', async () => {
  await db.prisma.workspacePRDelivery.create({
    data: {
      id: 'receipt',
      workspaceId: 'workspace',
      eventIds: ['second', 'first'],
      state: 'DELIVERED',
      text: 'frozen',
    },
  });
  await fact('first', 'workspace', 'receipt');
  await fact('second', 'workspace', 'receipt');
  await fact('conflict', 'workspace');
  const backup = await dataBackupService.exportData('test');
  await clear();
  await localWorkspace();
  const local = await fact('conflict', 'local-workspace');
  const result = await dataBackupService.importData(backup);
  expect(await db.prisma.workspacePREvent.findUnique({ where: { id: 'conflict' } })).toEqual(local);
  expect(
    await db.prisma.workspacePRDelivery.findUnique({ where: { id: 'receipt' } })
  ).toMatchObject({ eventIds: ['second', 'first'], text: 'frozen', state: 'DELIVERED' });
  expect(result.recovery.models).toContainEqual({
    model: 'WorkspacePRDelivery',
    imported: 1,
    skipped: 0,
  });
  expect(result.recovery.models).toContainEqual({
    model: 'WorkspacePREvent',
    imported: 2,
    skipped: 1,
  });
});
