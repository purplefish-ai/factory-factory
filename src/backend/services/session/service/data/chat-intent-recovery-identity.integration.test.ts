import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import { configService } from '@/backend/services/config.service';
import { ChatIntentAccessor } from '@/backend/services/session/resources/chat-intent.accessor';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { PrismaClient } from '@prisma-gen/client';
const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!database.prisma) {
      throw new Error('Missing DB');
    }
    return database.prisma;
  },
}));
let db: IntegrationDatabase;
const settings = {
  selectedModel: 'original',
  reasoningEffort: null,
  thinkingEnabled: false,
  planModeEnabled: false,
};
async function seed(target: IntegrationDatabase, prefix: string) {
  await target.prisma.project.create({
    data: {
      id: `${prefix}-project`,
      name: prefix,
      slug: prefix,
      repoPath: `/${prefix}`,
      worktreeBasePath: `/${prefix}-trees`,
    },
  });
  await target.prisma.workspace.create({
    data: { id: `${prefix}-workspace`, projectId: `${prefix}-project`, name: prefix },
  });
  await target.prisma.agentSession.create({
    data: {
      id: `${prefix}-session`,
      workspaceId: `${prefix}-workspace`,
      provider: 'CODEX',
      providerSessionId: 'native',
      model: 'original',
      workflow: 'default',
    },
  });
}
beforeEach(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
  vi.spyOn(configService, 'getBaseDir').mockImplementation(() => db.tempDir);
  await seed(db, 'source');
});
afterEach(async () => {
  await destroyIntegrationDatabase(db);
});
it('remaps installation-local numeric IDs without losing human membership, source order, frozen proof or report accuracy', async () => {
  const source = new ChatIntentAccessor(db.prisma);
  for (const id of ['first', 'second']) {
    await source.accept(
      'source-session',
      { id, text: id, timestamp: '2026-01-01T00:00:00.000Z', settings },
      false
    );
  }
  await source.override('source-session', Date.parse('2026-01-02'), { selectedModel: 'desired' });
  const messages = (await source.read('source-session')).map((row) => row.message);
  const attemptId = await source.claim(
    'source-session',
    messages,
    'exact combined content',
    messages[0]!.settings,
    4,
    undefined,
    { provider: 'CODEX', providerSessionId: 'native', configOptions: [] }
  );
  expect(attemptId).not.toBeNull();
  const originalRows = await db.prisma.chatIntent.findMany({ orderBy: { id: 'asc' } });
  const originalAttempt = await db.prisma.promptDispatchAttempt.findFirstOrThrow();
  const backup = await dataBackupService.exportData('test');
  backup.data.durable!.chatIntent.reverse();
  const target = await createIntegrationDatabase();
  try {
    database.prisma = target.prisma;
    vi.spyOn(configService, 'getBaseDir').mockReturnValue(target.tempDir);
    await seed(target, 'local');
    const owner = new ChatIntentAccessor(target.prisma);
    await owner.accept(
      'local-session',
      {
        id: 'local',
        text: 'Unrelated local intent',
        timestamp: '2026-01-01T00:00:00.000Z',
        settings,
      },
      false
    );
    const local = await target.prisma.chatIntent.findFirstOrThrow();
    expect(local.id).toBe(originalRows[0]!.id);
    const result = await dataBackupService.importData(backup);
    expect(result.recovery.models).toContainEqual({ model: 'ChatIntent', imported: 2, skipped: 0 });
    expect(result.recovery.models).toContainEqual({
      model: 'PromptDispatchAttempt',
      imported: 1,
      skipped: 0,
    });
    const restored = await target.prisma.chatIntent.findMany({
      where: { sessionId: 'source-session' },
      orderBy: { id: 'asc' },
    });
    expect(restored.map(({ id: _id, ...row }) => row)).toEqual(
      originalRows.map(({ id: _id, ...row }) => row)
    );
    expect(restored[0]!.id).not.toBe(originalRows[0]!.id);
    expect(
      await target.prisma.promptDispatchAttempt.findUnique({ where: { id: attemptId! } })
    ).toEqual(originalAttempt);
    await owner.resolve('source-session', attemptId!, 'cancelled');
    expect(await owner.hasUncertainAttempt('source-session')).toBe(false);
    expect((await owner.read('source-session')).map((row) => [row.message.id, row.status])).toEqual(
      [
        ['first', 'cancelled'],
        ['second', 'cancelled'],
      ]
    );
    expect(await target.prisma.chatIntent.findUnique({ where: { id: local.id } })).toEqual(local);
  } finally {
    database.prisma = db.prisma;
    await destroyIntegrationDatabase(target);
  }
});
