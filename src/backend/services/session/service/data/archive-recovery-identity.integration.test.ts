import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { AgentContentItem, ChatMessage } from '@/shared/acp-protocol';
import { archiveRecoverySchema } from '@/shared/schemas/archive-recovery.schema';

let db: IntegrationDatabase;
let recovery: typeof import('./archive-recovery');
let producer: typeof import('@/backend/services/session/service/lifecycle/closed-session-persistence.service');
let storage: typeof import('@/backend/services/session/service/lifecycle/closed-session-storage');
let config: typeof import('@/backend/services/config.service').configService;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  vi.stubEnv('BASE_DIR', db.tempDir);
  recovery = await vi.importActual('./archive-recovery');
  producer = await vi.importActual(
    '@/backend/services/session/service/lifecycle/closed-session-persistence.service'
  );
  storage = await vi.importActual(
    '@/backend/services/session/service/lifecycle/closed-session-storage'
  );
  ({ configService: config } = await vi.importActual('@/backend/services/config.service'));
});
beforeEach(async () => {
  vi.spyOn(config, 'getBaseDir').mockReturnValue(db.tempDir);
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
});
afterEach(async () => {
  await producer.closedSessionPersistenceService.stopArchiveMaintenance();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await rm(join(db.tempDir, 'closed-sessions'), { recursive: true, force: true });
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
  vi.unstubAllEnvs();
});

function input(provider: 'CLAUDE' | 'CODEX', missingInitialToolInput: boolean) {
  const image: AgentContentItem = {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
    },
  };
  const tool = { type: 'tool_use' as const, id: 'call', name: 'Read', input: {} };
  // The existing producer explicitly supports streamed tool starts before input.
  if (missingInitialToolInput) {
    Reflect.deleteProperty(tool, 'input');
  }
  const messages: ChatMessage[] = [
    {
      id: 'user-1',
      source: 'user',
      text: 'first human',
      timestamp: '2026-01-01T00:00:00Z',
      order: 0,
      providerPrompt: [{ type: 'text', text: 'Frozen first\n\nsecond' }, image],
    },
    {
      id: 'user-2',
      source: 'user',
      text: 'second human',
      timestamp: '2026-01-01T00:00:01Z',
      order: 1,
      providerPrompt: null,
    },
    {
      id: 'tool',
      source: 'agent',
      timestamp: '2026-01-01T00:00:02Z',
      order: 2,
      message: {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: tool },
      },
    },
    {
      id: 'answer',
      source: 'agent',
      timestamp: '2026-01-01T00:00:03Z',
      order: 3,
      message: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Provider answer' }] },
      },
    },
  ];
  return {
    sessionId: 'session',
    workspaceId: 'workspace',
    worktreePath: join(db.tempDir, 'removed-worktree'),
    name: 'conversation',
    workflow: 'ratchet',
    provider,
    codexAccountId: provider === 'CODEX' ? 'original-account' : null,
    providerSessionId: 'original-native',
    conversationEpoch: 2,
    model: 'model',
    startedAt: new Date('2026-01-01'),
    messages,
  };
}

it.each(['CLAUDE', 'CODEX'] as const)(
  'rejects changed %s producer bytes with refreshed checksum but another snapshot key before relational writes',
  async (provider) => {
    await producer.closedSessionPersistenceService.persistClosedSession(input(provider, false));
    const original = await db.prisma.closedSession.findFirstOrThrow();
    const packaged = await recovery.exportSessionArchives(
      [original],
      new Map([['workspace', null]])
    );
    const entry = packaged.entries[0];
    if (!entry) {
      throw new Error('Missing package');
    }
    entry.transcript = entry.transcript.replace('Provider answer', 'Attacker answer');
    entry.sha256 = storage.archiveDigest(entry.transcript);
    entry.byteLength = Buffer.byteLength(entry.transcript);
    expect(archiveRecoverySchema.safeParse(packaged).success).toBe(true);
    await db.prisma.closedSession.deleteMany();
    await db.prisma.$transaction(async (tx) => {
      const create = vi.spyOn(tx.closedSession, 'create');
      await expect(
        recovery.restoreSessionArchives(tx, packaged, new Set(['workspace']))
      ).rejects.toThrow('Invalid content archive identity');
      // The callback commits: rollback cannot hide a write attempted before rejection.
      expect(create).not.toHaveBeenCalled();
    });
    expect(await db.prisma.closedSession.count()).toBe(0);
  }
);

it.each([false, true])(
  'preserves real providerPrompt/image/epoch bytes and restart dedupe with absent initial tool input=%s',
  async (missingInitialToolInput) => {
    const originalInput = input('CODEX', missingInitialToolInput);
    await producer.closedSessionPersistenceService.persistClosedSession(originalInput);
    const original = await db.prisma.closedSession.findFirstOrThrow();
    const packaged = await recovery.exportSessionArchives(
      [original],
      new Map([['workspace', null]])
    );
    const bytes = packaged.entries[0]?.transcript;
    expect(bytes).toBeDefined();
    await db.prisma.closedSession.deleteMany();
    const ids = await db.prisma.$transaction((tx) =>
      recovery.restoreSessionArchives(tx, packaged, new Set(['workspace']))
    );
    await recovery.publishRestoredSessionArchives(ids);
    vi.resetModules();
    const restarted: typeof producer = await vi.importActual(
      '@/backend/services/session/service/lifecycle/closed-session-persistence.service'
    );
    await restarted.closedSessionPersistenceService.persistClosedSession(originalInput);
    const rows = await db.prisma.closedSession.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.archiveKey).toBe(original.archiveKey);
    const restored = rows[0];
    if (!restored) {
      throw new Error('Missing restored row');
    }
    expect(await readFile(storage.resolveClosedSessionTranscriptPath(restored, null), 'utf8')).toBe(
      bytes
    );
    expect(await recovery.exportSessionArchives(rows, new Map([['workspace', null]]))).toEqual(
      packaged
    );
  }
);
