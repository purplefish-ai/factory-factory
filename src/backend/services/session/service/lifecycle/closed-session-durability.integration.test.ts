import * as fs from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

let db: IntegrationDatabase;
let service: typeof import('./closed-session-persistence.service').closedSessionPersistenceService;
let accessor: typeof import('@/backend/services/session/resources/closed-session.accessor').closedSessionAccessor;
let paths: typeof import('./closed-session-storage');
let config: typeof import('@/backend/services/config.service').configService;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  ({ configService: config } = await vi.importActual<
    typeof import('@/backend/services/config.service')
  >('@/backend/services/config.service'));
  ({ closedSessionPersistenceService: service } = await vi.importActual<
    typeof import('./closed-session-persistence.service')
  >('./closed-session-persistence.service'));
  ({ closedSessionAccessor: accessor } = await vi.importActual<
    typeof import('@/backend/services/session/resources/closed-session.accessor')
  >('@/backend/services/session/resources/closed-session.accessor'));
  paths = await vi.importActual<typeof import('./closed-session-storage')>(
    './closed-session-storage'
  );
});
beforeEach(async () => {
  vi.spyOn(config, 'getBaseDir').mockReturnValue(db.tempDir);
  const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fs.open).mockReset().mockImplementation(open);
  const project = await db.prisma.project.create({
    data: {
      name: 'durability',
      slug: 'durability',
      repoPath: '/repo',
      worktreeBasePath: '/worktrees',
    },
  });
  await db.prisma.workspace.create({
    data: { id: 'workspace', name: 'durability', projectId: project.id },
  });
});
afterEach(async () => {
  await service.stopArchiveMaintenance();
  vi.restoreAllMocks();
  await clearIntegrationDatabase(db.prisma);
  await fs.rm(join(db.tempDir, 'closed-sessions'), { recursive: true, force: true });
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

it.each(['file', 'directory'])(
  'keeps immutable PENDING bytes after actual %s fsync failure and recovers them',
  async (phase) => {
    const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const syncFailure = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('injected sync failure'));
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await open(...args);
      const path = String(args[0]);
      if (
        (phase === 'file' && basename(path).startsWith('.tmp-archive-')) ||
        (phase === 'directory' && path === paths.closedSessionWorkspaceDirectory('workspace'))
      ) {
        vi.spyOn(handle, 'sync').mockImplementation(syncFailure);
      }
      return handle;
    });
    await expect(
      service.persistClosedSession({
        sessionId: 'session',
        workspaceId: 'workspace',
        worktreePath: '/unused',
        name: null,
        workflow: 'ratchet',
        provider: 'CLAUDE',
        providerSessionId: 'thread',
        model: 'model',
        startedAt: new Date(0),
        messages: [
          {
            id: 'message',
            source: 'user',
            text: 'first retained bytes',
            order: 0,
            timestamp: '2026-01-01',
          },
        ],
      })
    ).rejects.toThrow('injected sync failure');
    expect(syncFailure).toHaveBeenCalledOnce();
    const pending = await db.prisma.closedSession.findFirstOrThrow();
    const bytes = pending.pendingTranscript;
    expect(pending.archiveState).toBe('PENDING');
    expect(bytes).toContain('first retained bytes');
    expect(await accessor.findByWorkspaceId('workspace', 20)).toEqual([]);
    const path = paths.resolveClosedSessionTranscriptPath(pending, null);
    if (phase === 'file') {
      await expect(fs.readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(await fs.readFile(path, 'utf8')).toBe(bytes);
    }
    vi.mocked(fs.open).mockImplementation(open);
    await service.recoverPending('workspace');
    const complete = await db.prisma.closedSession.findUniqueOrThrow({ where: { id: pending.id } });
    expect(complete.archiveState).toBe('COMPLETE');
    expect(complete.pendingTranscript).toBeNull();
    expect(await fs.readFile(path, 'utf8')).toBe(bytes);
    expect(await db.prisma.closedSession.count()).toBe(1);
    expect(await fs.readdir(paths.closedSessionWorkspaceDirectory('workspace'))).toEqual([
      basename(path),
    ]);
  }
);
