import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configService } from '@/backend/services/config.service';
import { type PrismaClient } from '@prisma-gen/client';
import { dataBackupService } from '../orchestration/data-backup.service';
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

it('rejects a missing required schedule parent atomically instead of silently losing executions', async () => {
  await db.prisma.periodicTask.create({
    data: {
      id: 'task',
      projectId: 'project',
      name: 'task',
      prompt: 'go',
      cadence: 'DAILY',
      nextRunAt: new Date(),
    },
  });
  await db.prisma.periodicTaskExecution.create({
    data: { id: 'execution', periodicTaskId: 'task', status: 'COMPLETED' },
  });
  const backup = await dataBackupService.exportData('test');
  backup.data.durable!.periodicTask = [];
  await db.prisma.periodicTask.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await expect(dataBackupService.importData(backup)).rejects.toThrow(/required parent/i);
  expect(await db.prisma.project.count()).toBe(0);
});
it('rejects missing automation parents while preserving required history atomically', async () => {
  await db.prisma.agentDefinition.create({
    data: { id: 'definition', projectId: 'project', name: 'agent', instructions: 'go' },
  });
  await db.prisma.agentRun.create({
    data: {
      id: 'run',
      agentDefinitionId: 'definition',
      idempotencyKey: 'run',
      definitionSnapshot: {},
      input: {},
      status: 'COMPLETED',
    },
  });
  const backup = await dataBackupService.exportData('test');
  backup.data.durable!.agentDefinition = [];
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await expect(dataBackupService.importData(backup)).rejects.toThrow(/required parent/i);
  expect(await db.prisma.project.count()).toBe(0);
});
it('rejects an archive without its required workspace before any parent is imported', async () => {
  const backup = await dataBackupService.exportData('test');
  const timestamp = '2026-01-01T00:00:00.000Z';
  const metadata = {
    name: null,
    workflow: 'default',
    provider: 'CODEX' as const,
    model: 'default',
    startedAt: timestamp,
    completedAt: timestamp,
  };
  const transcript = JSON.stringify({
    version: 1,
    workspaceId: 'missing',
    sessionId: 'deleted',
    metadata,
    messages: [],
  });
  backup.data.archives!.entries.push({
    id: 'archive',
    workspaceId: 'missing',
    sessionId: 'deleted',
    ...metadata,
    archiveKey: 'a'.repeat(64),
    transcript,
    byteLength: Buffer.byteLength(transcript),
    sha256: createHash('sha256').update(transcript).digest('hex'),
  });
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await expect(dataBackupService.importData(backup)).rejects.toThrow(/required parent/i);
  expect(await db.prisma.project.count()).toBe(0);
});

it('reports retained identities skipped for local collisions or rejected parents alongside imported history', async () => {
  await db.prisma.periodicTask.create({
    data: {
      id: 'task',
      projectId: 'project',
      name: 'local task',
      prompt: 'go',
      cadence: 'DAILY',
      nextRunAt: new Date(),
    },
  });
  await db.prisma.periodicTaskExecution.create({
    data: { id: 'execution', periodicTaskId: 'task', status: 'COMPLETED' },
  });
  await db.prisma.decisionLog.create({
    data: { id: 'decision', agentId: 'deleted-session', decision: 'kept', reasoning: 'historical' },
  });
  const backup = await dataBackupService.exportData('test');
  await db.prisma.periodicTaskExecution.deleteMany();
  await db.prisma.decisionLog.deleteMany();
  const result = await dataBackupService.importData(backup);
  expect(result.recovery.models).toEqual(
    expect.arrayContaining([
      { model: 'PeriodicTask', imported: 0, skipped: 1 },
      { model: 'PeriodicTaskExecution', imported: 0, skipped: 1 },
      { model: 'DecisionLog', imported: 1, skipped: 0 },
    ])
  );
  expect(result.recovery.skipped).toEqual(
    expect.arrayContaining([
      { model: 'PeriodicTask', identity: 'task', reason: 'EXISTING_IDENTITY' },
      {
        model: 'PeriodicTaskExecution',
        identity: 'execution',
        reason: 'CONFLICTING_IDENTITY_OR_PARENT',
      },
    ])
  );
  expect(await db.prisma.periodicTaskExecution.count()).toBe(0);
  expect(await db.prisma.decisionLog.count()).toBe(1);
});
