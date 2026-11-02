import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { getClosedSessionArchiveKey } from '@/backend/services/session/service/lifecycle/closed-session-identity';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { ArchiveRecovery } from '@/shared/schemas/archive-recovery.schema';

let db: IntegrationDatabase;
let recovery: typeof import('./archive-recovery');
let storage: typeof import('@/backend/services/session/service/lifecycle/closed-session-storage');
let publisher: typeof import('@/backend/services/session/service/lifecycle/closed-session-persistence.service');
let atomic: typeof import('@/backend/lib/atomic-file');
let config: typeof import('@/backend/services/config.service').configService;
const startedAt = '2026-01-01T00:00:00.000Z';
const completedAt = '2026-01-02T00:00:00.000Z';

beforeAll(async () => {
  db = await createIntegrationDatabase();
  vi.stubEnv('BASE_DIR', db.tempDir);
  recovery = await vi.importActual('./archive-recovery');
  storage = await vi.importActual(
    '@/backend/services/session/service/lifecycle/closed-session-storage'
  );
  publisher = await vi.importActual(
    '@/backend/services/session/service/lifecycle/closed-session-persistence.service'
  );
  atomic = await vi.importActual('@/backend/lib/atomic-file');
  ({ configService: config } = await vi.importActual('@/backend/services/config.service'));
});
beforeEach(async () => {
  vi.spyOn(config, 'getBaseDir').mockReturnValue(db.tempDir);
  const project = await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'recovery',
      slug: 'recovery',
      repoPath: '/repo',
      worktreeBasePath: '/worktrees',
    },
  });
  await db.prisma.workspace.createMany({
    data: ['workspace', 'other-workspace'].map((id) => ({ id, projectId: project.id, name: id })),
  });
});
afterEach(async () => {
  await publisher.closedSessionPersistenceService.stopArchiveMaintenance();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await rm(join(db.tempDir, 'closed-sessions'), { recursive: true, force: true });
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
  vi.unstubAllEnvs();
});

function packageFor(
  id = 'archive',
  conversationIdentity = 'a'.repeat(64),
  workspaceId = 'workspace'
): ArchiveRecovery {
  const transcript = JSON.stringify(
    {
      version: 1,
      sessionId: 'session',
      workspaceId,
      metadata: {
        name: null,
        workflow: 'ratchet',
        provider: 'CODEX',
        codexAccountId: 'unmapped-original-account',
        providerSessionId: conversationIdentity,
        model: 'model',
        startedAt,
        completedAt,
      },
      messages: [],
    },
    null,
    2
  );
  return {
    version: 1,
    entries: [
      {
        id,
        archiveKey: getClosedSessionArchiveKey({
          workspaceId,
          sessionId: 'session',
          provider: 'CODEX',
          providerSessionId: conversationIdentity,
          codexAccountId: 'unmapped-original-account',
          startedAt: new Date(startedAt),
          messages: [],
        }),
        workspaceId,
        sessionId: 'session',
        name: null,
        workflow: 'ratchet',
        provider: 'CODEX',
        model: 'model',
        startedAt,
        completedAt,
        transcript,
        byteLength: Buffer.byteLength(transcript),
        sha256: storage.archiveDigest(transcript),
      },
    ],
  };
}

it('stages PENDING exact bytes without filesystem publication, then completes after commit', async () => {
  const input = packageFor();
  const ids = await db.prisma.$transaction((tx) =>
    recovery.restoreSessionArchives(tx, input, new Set(['workspace']))
  );
  expect(ids).toEqual(['archive']);
  const row = await db.prisma.closedSession.findUniqueOrThrow({ where: { id: 'archive' } });
  expect(row).toMatchObject({
    archiveState: 'PENDING',
    pendingTranscript: input.entries[0]!.transcript,
    transcriptHash: input.entries[0]!.sha256,
  });
  const path = storage.resolveClosedSessionTranscriptPath(row, null);
  await expect(readFile(path)).rejects.toThrow();
  await recovery.publishRestoredSessionArchives(ids);
  expect(await readFile(path, 'utf8')).toBe(input.entries[0]!.transcript);
  expect(
    await db.prisma.closedSession.findUniqueOrThrow({ where: { id: 'archive' } })
  ).toMatchObject({ archiveState: 'COMPLETE', pendingTranscript: null });
});

it('excludes skipped workspace parents and local id/key collisions without borrowing ownership', async () => {
  const existing = packageFor();
  await db.prisma.$transaction((tx) =>
    recovery.restoreSessionArchives(tx, existing, new Set(['workspace']))
  );
  const collisionId = packageFor('archive', 'b'.repeat(64), 'other-workspace');
  const collisionKey = packageFor('other-archive', 'a'.repeat(64), 'workspace');
  const skippedParent = packageFor('third-archive', 'c'.repeat(64), 'other-workspace');
  for (const input of [collisionId, collisionKey]) {
    expect(
      await db.prisma.$transaction((tx) =>
        recovery.restoreSessionArchives(tx, input, new Set(['workspace', 'other-workspace']))
      )
    ).toEqual([]);
  }
  expect(
    await db.prisma.$transaction((tx) =>
      recovery.restoreSessionArchives(tx, skippedParent, new Set())
    )
  ).toEqual([]);
  expect(await db.prisma.closedSession.count()).toBe(1);
  expect(
    await db.prisma.closedSession.findUniqueOrThrow({ where: { id: 'archive' } })
  ).toMatchObject({ workspaceId: 'workspace', pendingTranscript: existing.entries[0]!.transcript });
});

it('rolls back staged archives with the caller transaction', async () => {
  await expect(
    db.prisma.$transaction(async (tx) => {
      await recovery.restoreSessionArchives(tx, packageFor(), new Set(['workspace']));
      throw new Error('later import failed');
    })
  ).rejects.toThrow('later import failed');
  expect(await db.prisma.closedSession.count()).toBe(0);
});

it('deduplicates repeated concurrent imports without replacing frozen bytes', async () => {
  const input = packageFor();
  const results = await Promise.all(
    [1, 2].map(() =>
      db.prisma.$transaction((tx) =>
        recovery.restoreSessionArchives(tx, input, new Set(['workspace']))
      )
    )
  );
  expect(results.flat()).toEqual(['archive']);
  expect(await db.prisma.closedSession.count()).toBe(1);
});

it('retains durable PENDING bytes after interrupted publication and recovers them after restart', async () => {
  const input = packageFor();
  const ids = await db.prisma.$transaction((tx) =>
    recovery.restoreSessionArchives(tx, input, new Set(['workspace']))
  );
  const fail = vi
    .spyOn(atomic, 'writeFileAtomic')
    .mockRejectedValueOnce(new Error('publication interrupted'));
  await expect(recovery.publishRestoredSessionArchives(ids)).rejects.toThrow(
    'publication interrupted'
  );
  fail.mockRestore();
  expect(
    await db.prisma.closedSession.findUniqueOrThrow({ where: { id: 'archive' } })
  ).toMatchObject({ archiveState: 'PENDING', pendingTranscript: input.entries[0]!.transcript });
  vi.resetModules();
  const restarted: typeof publisher = await vi.importActual(
    '@/backend/services/session/service/lifecycle/closed-session-persistence.service'
  );
  await restarted.closedSessionPersistenceService.recoverById('archive');
  const row = await db.prisma.closedSession.findUniqueOrThrow({ where: { id: 'archive' } });
  expect(row.archiveState).toBe('COMPLETE');
  expect(await readFile(storage.resolveClosedSessionTranscriptPath(row, null), 'utf8')).toBe(
    input.entries[0]!.transcript
  );
});

it('fails export when a complete artifact is deleted after the relational snapshot', async () => {
  const input = packageFor();
  const ids = await db.prisma.$transaction((tx) =>
    recovery.restoreSessionArchives(tx, input, new Set(['workspace']))
  );
  await recovery.publishRestoredSessionArchives(ids);
  const snapshot = await db.prisma.closedSession.findMany();
  const path = storage.resolveClosedSessionTranscriptPath(snapshot[0]!, null);
  await rm(path);
  await expect(
    recovery.exportSessionArchives(snapshot, new Map([['workspace', null]]))
  ).rejects.toThrow('Incomplete archive export');
});

it('does not overwrite a different artifact when wire identifiers contain traversal', async () => {
  const input = packageFor();
  input.entries[0]!.id = '../outside';
  const entry = input.entries[0]!;
  const target = join(
    db.tempDir,
    storage.closedSessionArchivePath(entry.workspaceId, entry.id, entry.sha256)
  );
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, 'existing unrelated artifact');
  await db.prisma.$transaction(async (tx) => {
    const create = vi.spyOn(tx.closedSession, 'create');
    await expect(
      recovery.restoreSessionArchives(tx, input, new Set(['workspace']))
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'invalid_format', path: ['entries', 0, 'id'] })],
    });
    expect(create).not.toHaveBeenCalled();
  });
  expect(await readFile(target, 'utf8')).toBe('existing unrelated artifact');
  expect(await db.prisma.closedSession.count()).toBe(0);
});

it.each([
  { preserved: false, marker: true },
  { preserved: true, marker: true },
  { preserved: false, marker: false },
  { preserved: true, marker: false },
])(
  'roundtrips actual legacy writer timing with preserved=$preserved marker=$marker without changing row clocks or frozen bytes',
  async ({ preserved, marker }) => {
    // Pre-protocol persistence wrote JSON before a second new Date() for the DB row.
    const fileCompletedAt = '2026-01-02T00:00:00.001Z';
    const rowCompletedAt = new Date('2026-01-02T00:00:00.009Z');
    const oldTranscript = JSON.stringify(
      {
        version: 1,
        sessionId: 'legacy-session',
        workspaceId: 'workspace',
        metadata: {
          name: null,
          workflow: 'ratchet',
          provider: 'CLAUDE',
          model: 'sonnet',
          startedAt,
          completedAt: fileCompletedAt,
        },
        messages: [
          {
            id: 'old-user',
            source: 'user',
            text: 'Original legacy request',
            timestamp: startedAt,
            order: 0,
          },
          {
            id: 'old-agent',
            source: 'agent',
            message: {
              type: 'assistant',
              message: { role: 'assistant', content: 'Original legacy answer' },
            },
            timestamp: fileCompletedAt,
            order: 1,
          },
        ],
      },
      null,
      2
    );
    const worktree = join(db.tempDir, 'legacy-worktree');
    const relativePath = '.context/closed-sessions/legacy-session_2026-01-02T00-00-00-000Z.json';
    const { mkdir, writeFile } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await mkdir(join(worktree, '.context/closed-sessions'), { recursive: true });
    await writeFile(join(worktree, relativePath), oldTranscript);
    await db.prisma.workspace.update({
      where: { id: 'workspace' },
      data: { worktreePath: worktree },
    });
    await db.prisma.closedSession.create({
      data: {
        id: 'legacy-archive',
        workspaceId: 'workspace',
        sessionId: 'legacy-session',
        name: null,
        workflow: 'ratchet',
        provider: 'CLAUDE',
        model: 'sonnet',
        startedAt: new Date(startedAt),
        completedAt: rowCompletedAt,
        transcriptPath: relativePath,
        archiveKey: null,
        archiveState: 'COMPLETE',
      },
    });
    if (preserved) {
      await publisher.closedSessionPersistenceService.preserveWorkspaceArchives('workspace');
    }
    const snapshot = await db.prisma.closedSession.findMany();
    const packaged = await recovery.exportSessionArchives(
      snapshot,
      new Map([['workspace', worktree]])
    );
    expect(packaged.entries[0]).toMatchObject({
      identity: 'legacy-v1',
      completedAt: rowCompletedAt.toISOString(),
      transcript: oldTranscript,
    });
    if (!marker) {
      Reflect.deleteProperty(packaged.entries[0]!, 'identity');
    }
    await db.prisma.closedSession.deleteMany();
    await rm(worktree, { recursive: true, force: true });
    const ids = await db.prisma.$transaction((tx) =>
      recovery.restoreSessionArchives(tx, packaged, new Set(['workspace']))
    );
    await recovery.publishRestoredSessionArchives(ids);
    const restored = await db.prisma.closedSession.findUniqueOrThrow({
      where: { id: 'legacy-archive' },
    });
    expect(restored.completedAt).toEqual(rowCompletedAt);
    expect(await readFile(storage.resolveClosedSessionTranscriptPath(restored, null), 'utf8')).toBe(
      oldTranscript
    );
    const reexported = await recovery.exportSessionArchives(
      [restored],
      new Map([['workspace', null]])
    );
    expect(reexported).toEqual({
      ...packaged,
      entries: packaged.entries.map((entry) => ({ ...entry, identity: 'legacy-v1' })),
    });
  }
);
