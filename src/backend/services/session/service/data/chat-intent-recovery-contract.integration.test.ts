import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { submittedIntentSchema } from '@/shared/schemas/chat-intent.schema';
import { durableRecoverySchema } from '@/shared/schemas/durable-recovery.schema';

const database = vi.hoisted(() => ({
  prisma: undefined as import('@prisma-gen/client').PrismaClient | undefined,
}));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!database.prisma) {
      throw new Error('Missing recovery DB');
    }
    return database.prisma;
  },
}));
let db: IntegrationDatabase;
let Accessor: typeof import('../../resources/chat-intent.accessor').ChatIntentAccessor;
let restore: typeof import('../../resources/chat-intent.accessor').restoreRecoveryChatIntents;
const settings = {
  selectedModel: 'original-model',
  reasoningEffort: null,
  thinkingEnabled: false,
  planModeEnabled: false,
};
const message = {
  id: 'message',
  text: 'Original provider request',
  timestamp: '2026-01-01T00:00:00.000Z',
  attachments: [
    {
      id: 'text',
      name: 'notes.txt',
      type: 'text/plain',
      size: 4,
      data: 'note',
      contentType: 'text' as const,
    },
  ],
  voiceMode: false,
  settings,
};
beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
  vi.stubEnv('BASE_DIR', db.tempDir);
  ({ ChatIntentAccessor: Accessor, restoreRecoveryChatIntents: restore } = await vi.importActual(
    '../../resources/chat-intent.accessor'
  ));
});
beforeEach(async () => {
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Recovery',
      slug: 'recovery',
      repoPath: '/repo',
      worktreeBasePath: '/trees',
    },
  });
  await db.prisma.workspace.create({
    data: { id: 'workspace', projectId: 'project', name: 'Recovery' },
  });
  await db.prisma.agentSession.create({
    data: {
      id: 'session',
      workspaceId: 'workspace',
      provider: 'CODEX',
      providerSessionId: 'original-native',
      model: 'original-model',
      workflow: 'default',
    },
  });
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
  vi.unstubAllEnvs();
});

async function producerSnapshot() {
  const owner = new Accessor(db.prisma);
  await owner.accept('session', message, false);
  await owner.override('session', Date.parse(message.timestamp) + 1, {
    selectedModel: 'desired-model',
    planModeEnabled: true,
  });
  const [current] = await owner.read('session');
  if (!current) {
    throw new Error('Missing accepted intent');
  }
  const external = {
    id: 'external',
    text: 'External frozen request',
    timestamp: message.timestamp,
    settings,
    provenance: { originalProvider: 'CODEX', evidence: ['retained', 'verbatim'] },
  };
  const effective = {
    ...current.message.settings,
    providerMetadata: { originalModelSelection: 'desired-model' },
  };
  await owner.claim(
    'session',
    [current.message, external],
    [{ type: 'text', text: 'Frozen combined prompt' }],
    effective,
    7,
    undefined,
    {
      provider: 'CODEX',
      providerSessionId: 'original-native',
      configOptions: [{ id: 'model', currentValue: 'desired-model' }],
    }
  );
  const rows = {
    chatIntent: await db.prisma.chatIntent.findMany(),
    promptDispatchAttempt: await db.prisma.promptDispatchAttempt.findMany(),
  };
  const decoded: unknown = JSON.parse(
    JSON.stringify({
      ...Object.fromEntries(
        Object.keys(durableRecoverySchema.shape).map((key) => [
          key,
          key === 'jsonStorage' ? { version: 1, jsonNulls: [] } : [],
        ])
      ),
      ...rows,
    })
  );
  return { owner, snapshot: durableRecoverySchema.parse(decoded), decoded };
}

it('roundtrips actual accepted/overridden/frozen producer rows and remains readable by owner decoders', async () => {
  const { owner, snapshot } = await producerSnapshot();
  const expectedFingerprint = createHash('sha256')
    .update(JSON.stringify({ ...submittedIntentSchema.parse(message), timestamp: undefined }))
    .digest('hex');
  expect(snapshot.chatIntent[0]?.fingerprint).toBe(expectedFingerprint);
  await db.prisma.chatIntent.deleteMany();
  await db.prisma.promptDispatchAttempt.deleteMany();
  await db.prisma.$transaction((tx) => restore(tx, snapshot, new Set(['session'])));
  const restoredIntents = await db.prisma.chatIntent.findMany();
  const restoredAttempts = await db.prisma.promptDispatchAttempt.findMany();
  expect(JSON.parse(JSON.stringify(restoredIntents))).toEqual(snapshot.chatIntent);
  expect(JSON.parse(JSON.stringify(restoredAttempts))).toEqual(snapshot.promptDispatchAttempt);
  await expect(owner.read('session', true)).resolves.toMatchObject([
    {
      message: {
        id: 'message',
        settings: { selectedModel: 'desired-model', planModeEnabled: true },
      },
      status: 'uncertain',
    },
  ]);
  await expect(owner.listUncertain('session')).resolves.toMatchObject([
    {
      members: [
        { id: 'message', owner: 'human' },
        { id: 'external', owner: 'external' },
      ],
      effectiveSettings: { selectedModel: 'desired-model' },
    },
  ]);
});

it.each(['submitted', 'desired', 'effectiveSettings'])(
  'rejects malformed %s before the restore transaction writes',
  async (field) => {
    const { snapshot } = await producerSnapshot();
    const corrupted = {
      ...snapshot,
      chatIntent: snapshot.chatIntent.map((row) =>
        field === 'effectiveSettings' ? row : { ...row, [field]: null }
      ),
      promptDispatchAttempt: snapshot.promptDispatchAttempt.map((row) =>
        field === 'effectiveSettings' ? { ...row, effectiveSettings: null } : row
      ),
    };
    await db.prisma.chatIntent.deleteMany();
    await db.prisma.promptDispatchAttempt.deleteMany();
    await expect(
      db.prisma.$transaction((tx) =>
        restore(tx, durableRecoverySchema.parse(corrupted), new Set(['session']))
      )
    ).rejects.toThrow();
    expect(await db.prisma.chatIntent.count()).toBe(0);
    expect(await db.prisma.promptDispatchAttempt.count()).toBe(0);
  }
);

it('rejects a corrupted canonical fingerprint from a real producer export before importing parents', async () => {
  await producerSnapshot();
  const { dataBackupService } = await vi.importActual<
    typeof import('@/backend/orchestration/data-backup.service')
  >('@/backend/orchestration/data-backup.service');
  const backup = await dataBackupService.exportData('test');
  const intent = backup.data.durable?.chatIntent[0];
  if (!intent) {
    throw new Error('Missing accepted exported intent');
  }
  intent.fingerprint = '0'.repeat(64);
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await expect(dataBackupService.importData(backup)).rejects.toThrow(/fingerprint/i);
  expect(await db.prisma.project.count()).toBe(0);
  expect(await db.prisma.chatIntent.count()).toBe(0);
  expect(await db.prisma.promptDispatchAttempt.count()).toBe(0);
});
