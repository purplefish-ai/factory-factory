import * as fs from 'node:fs/promises';
import { basename } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

let db: IntegrationDatabase;
let archive: typeof import('@/backend/services/session/service/lifecycle/closed-session-persistence.service').closedSessionPersistenceService;
beforeAll(async () => {
  db = await createIntegrationDatabase();
});
afterEach(async () => {
  await archive?.stopArchiveMaintenance();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

it('serves a Windows COMPLETE transcript through the real router with its file cache offline', async () => {
  const { configService } = await vi.importActual<
    typeof import('@/backend/services/config.service')
  >('@/backend/services/config.service');
  vi.spyOn(configService, 'getBaseDir').mockReturnValue(db.tempDir);
  ({ closedSessionPersistenceService: archive } = await vi.importActual<
    typeof import('@/backend/services/session/service/lifecycle/closed-session-persistence.service')
  >('@/backend/services/session/service/lifecycle/closed-session-persistence.service'));
  const { sessionDataService } = await vi.importActual<
    typeof import('@/backend/services/session/service/data/session-data.service')
  >('@/backend/services/session/service/data/session-data.service');
  const paths = await vi.importActual<
    typeof import('@/backend/services/session/service/lifecycle/closed-session-storage')
  >('@/backend/services/session/service/lifecycle/closed-session-storage');
  const { closedSessionsRouter } = await vi.importActual<
    typeof import('@/backend/trpc/closed-sessions.trpc')
  >('@/backend/trpc/closed-sessions.trpc');
  const project = await db.prisma.project.create({
    data: { name: 'Windows', slug: 'windows', repoPath: '/repo', worktreeBasePath: '/worktrees' },
  });
  await db.prisma.workspace.create({
    data: { id: 'workspace', name: 'Windows', projectId: project.id },
  });
  const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.mocked(fs.open).mockImplementation((...args) => {
    if (String(args[0]) === paths.closedSessionWorkspaceDirectory('workspace')) {
      return Promise.reject(
        Object.assign(new Error('unsupported directory flush'), { code: 'EPERM' })
      );
    }
    return open(...args);
  });
  try {
    await archive.persistClosedSession({
      sessionId: 'session',
      workspaceId: 'workspace',
      worktreePath: '/unused',
      name: null,
      workflow: 'ratchet',
      provider: 'CLAUDE',
      providerSessionId: 'thread',
      model: 'model',
      startedAt: new Date(0),
      messages: [],
    });
    const row = await db.prisma.closedSession.findFirstOrThrow();
    const bytes = row.pendingTranscript;
    if (bytes === null) {
      throw new Error('Windows archive discarded its durable DB source');
    }
    expect(row.archiveState).toBe('COMPLETE');
    const file = paths.resolveClosedSessionTranscriptPath(row, null);
    await fs.unlink(file);
    vi.mocked(fs.open).mockImplementation((...args) => {
      if (basename(String(args[0])).startsWith('.tmp-archive-')) {
        return Promise.reject(new Error('archive cache offline'));
      }
      return open(...args);
    });
    const caller = closedSessionsRouter.createCaller({
      appContext: { services: { sessionDataService } },
    } as never);
    await expect(caller.getTranscript({ id: row.id })).resolves.toEqual(JSON.parse(bytes));
    expect((await caller.list({ workspaceId: 'workspace' }))[0]).not.toHaveProperty(
      'pendingTranscript'
    );
    expect(
      (await db.prisma.closedSession.findUniqueOrThrow({ where: { id: row.id } })).pendingTranscript
    ).toBe(bytes);
    await expect(fs.readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    Object.defineProperty(process, 'platform', platform);
    vi.mocked(fs.open).mockImplementation(open);
  }
});
