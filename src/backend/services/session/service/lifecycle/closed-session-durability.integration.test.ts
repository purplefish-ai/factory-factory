import * as fs from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { prEventMarker } from '@/shared/pr-monitoring';

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
    data: {
      id: 'workspace',
      name: 'durability',
      projectId: project.id,
      worktreePath: '/work/repo',
    },
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

async function withWindowsDirectorySyncUnavailable<T>(work: () => Promise<T>): Promise<T> {
  const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.mocked(fs.open).mockImplementation((...args) => {
    if (String(args[0]) === paths.closedSessionWorkspaceDirectory('workspace')) {
      return Promise.reject(
        Object.assign(new Error('Windows directory sync unavailable'), { code: 'EPERM' })
      );
    }
    return open(...args);
  });
  try {
    return await work();
  } finally {
    Object.defineProperty(process, 'platform', platform);
    vi.mocked(fs.open).mockImplementation(open);
  }
}

function persistWindowsArchive() {
  return service.persistClosedSession({
    sessionId: 'windows',
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
        text: 'immutable Windows proof',
        order: 0,
        timestamp: '2026-01-01',
      },
    ],
  });
}

async function readRetainedWindowsArchive() {
  const row = await db.prisma.closedSession.findFirstOrThrow();
  const bytes = row.pendingTranscript;
  if (bytes === null) {
    throw new Error('Windows archive discarded its durable DB proof');
  }
  expect(row.archiveState).toBe('COMPLETE');
  expect(bytes).toContain('immutable Windows proof');
  return { row, bytes, path: paths.resolveClosedSessionTranscriptPath(row, null) };
}

it('retains Windows COMPLETE proof and repairs a missing or corrupt file cache on use', async () => {
  const { sessionDataService } = await vi.importActual<
    typeof import('../data/session-data.service')
  >('../data/session-data.service');
  await withWindowsDirectorySyncUnavailable(async () => {
    await expect(persistWindowsArchive()).resolves.toBeUndefined();
    const { row, bytes, path } = await readRetainedWindowsArchive();
    expect(await fs.readFile(path, 'utf8')).toBe(bytes);
    await persistWindowsArchive();
    expect(await db.prisma.closedSession.count()).toBe(1);
    expect((await readRetainedWindowsArchive()).row.id).toBe(row.id);
    expect((await readRetainedWindowsArchive()).bytes).toBe(bytes);
    await fs.unlink(path);
    await service.stopArchiveMaintenance();
    expect((await sessionDataService.findClosedSessionByIdWithWorkspace(row.id))?.id).toBe(row.id);
    expect(await fs.readFile(path, 'utf8')).toBe(bytes);
    await fs.writeFile(path, 'corrupt cache');
    await sessionDataService.findClosedSessionByIdWithWorkspace(row.id);
    expect(await fs.readFile(path, 'utf8')).toBe(bytes);
    expect((await readRetainedWindowsArchive()).bytes).toBe(bytes);
  });
});

it('reads the retained DB transcript and provider receipt when its file cache cannot be repaired', async () => {
  const { sessionDataService } = await vi.importActual<
    typeof import('../data/session-data.service')
  >('../data/session-data.service');
  const { findPRDeliveryReceipt } =
    await vi.importActual<typeof import('./session-pr-receipt')>('./session-pr-receipt');
  const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const claudeDirectory = join(db.tempDir, 'claude');
  vi.spyOn(config, 'getClaudeConfigDir').mockReturnValue(claudeDirectory);
  const providerDirectory = join(claudeDirectory, 'projects', '-work-repo');
  await fs.mkdir(providerDirectory, { recursive: true });
  await fs.writeFile(
    join(providerDirectory, 'thread.jsonl'),
    JSON.stringify({
      type: 'user',
      sessionId: 'thread',
      message: { role: 'user', content: `${prEventMarker('delivery')}\nPR update` },
    })
  );
  await withWindowsDirectorySyncUnavailable(async () => {
    await persistWindowsArchive();
    const { row, bytes, path } = await readRetainedWindowsArchive();
    await fs.unlink(path);
    vi.mocked(fs.open).mockImplementation((...args) => {
      if (basename(String(args[0])).startsWith('.tmp-archive-')) {
        return Promise.reject(new Error('cache filesystem offline'));
      }
      return open(...args);
    });
    const retained = await sessionDataService.findClosedSessionByIdWithWorkspace(row.id);
    if (!retained) {
      throw new Error('Retained Windows archive is not visible');
    }
    expect(await sessionDataService.readClosedSessionTranscript(retained, path)).toBe(bytes);
    expect(await findPRDeliveryReceipt('windows', 'delivery')).toBe('delivered');
    expect(await findPRDeliveryReceipt('windows', 'other-delivery')).toBe('absent');
    expect(
      (await sessionDataService.findClosedSessionsByWorkspaceId('workspace', 20))[0]
    ).not.toHaveProperty('pendingTranscript');
    await expect(fs.readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readRetainedWindowsArchive()).bytes).toBe(bytes);
    for (const invalid of ['corrupt retained proof', '']) {
      await db.prisma.closedSession.update({
        where: { id: row.id },
        data: { pendingTranscript: invalid },
      });
      await expect(sessionDataService.findClosedSessionByIdWithWorkspace(row.id)).rejects.toThrow(
        'Invalid pending archive proof'
      );
      expect(await findPRDeliveryReceipt('windows', 'delivery')).toBe('unavailable');
    }
  });
});

it.skipIf(process.platform === 'win32')(
  'releases retained Windows bytes only after a later POSIX directory flush',
  async () => {
    const archive = await withWindowsDirectorySyncUnavailable(async () => {
      await persistWindowsArchive();
      return await readRetainedWindowsArchive();
    });
    await service.recoverById(archive.row.id);
    const complete = await db.prisma.closedSession.findUniqueOrThrow({
      where: { id: archive.row.id },
    });
    expect(complete.archiveState).toBe('COMPLETE');
    expect(complete.pendingTranscript).toBeNull();
    expect(await fs.readFile(archive.path, 'utf8')).toBe(archive.bytes);
  }
);

it.each([
  { platformName: 'win32', phase: 'file', code: 'EPERM' },
  { platformName: 'linux', phase: 'file', code: 'EPERM' },
  { platformName: 'win32', phase: 'directory', code: 'EIO' },
  { platformName: 'linux', phase: 'directory', code: 'EPERM' },
])('never degrades $phase sync $code on $platformName', async ({ platformName, phase, code }) => {
  const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platformName });
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    if (
      phase === 'directory' &&
      String(args[0]) === paths.closedSessionWorkspaceDirectory('workspace')
    ) {
      throw Object.assign(new Error('sync denied'), { code });
    }
    const handle = await open(...args);
    if (phase === 'file' && basename(String(args[0])).startsWith('.tmp-archive-')) {
      vi.spyOn(handle, 'sync').mockRejectedValue(Object.assign(new Error('sync denied'), { code }));
    }
    return handle;
  });
  try {
    await expect(
      service.persistClosedSession({
        sessionId: 'sync-denied',
        workspaceId: 'workspace',
        worktreePath: '/unused',
        name: null,
        workflow: 'ratchet',
        provider: 'CLAUDE',
        providerSessionId: 'thread',
        model: 'model',
        startedAt: new Date(0),
        messages: [],
      })
    ).rejects.toThrow('sync denied');
    const row = await db.prisma.closedSession.findFirstOrThrow();
    expect(row.archiveState).toBe('PENDING');
    expect(row.pendingTranscript).toBeTruthy();
    expect(await accessor.findByWorkspaceId('workspace', 20)).toEqual([]);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    vi.mocked(fs.open).mockImplementation(open);
  }
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
    expect(complete.pendingTranscript).toBe(process.platform === 'win32' ? bytes : null);
    expect(await fs.readFile(path, 'utf8')).toBe(bytes);
    expect(await db.prisma.closedSession.count()).toBe(1);
    expect(await fs.readdir(paths.closedSessionWorkspaceDirectory('workspace'))).toEqual([
      basename(path),
    ]);
  }
);

it('rejects published keyed archive bytes changed after completion while retaining legacy reads', async () => {
  await persistWindowsArchive();
  const row = await db.prisma.closedSession.findFirstOrThrow();
  const path = paths.resolveClosedSessionTranscriptPath(row, null);
  const original = await fs.readFile(path, 'utf8');
  await fs.writeFile(path, original.replace('immutable Windows proof', 'corrupt but valid proof'));
  await expect(service.readTranscript({ ...row, pendingTranscript: null }, path)).rejects.toThrow(
    'Archive transcript checksum mismatch'
  );
  expect(await service.readTranscript({ ...row, pendingTranscript: original }, path)).toBe(
    original
  );
  await expect(
    service.readTranscript({ ...row, pendingTranscript: 'corrupt DB source' }, path)
  ).rejects.toThrow('Invalid pending archive proof');
  expect(
    await service.readTranscript(
      { ...row, archiveKey: null, transcriptHash: null, pendingTranscript: null },
      path
    )
  ).toContain('corrupt but valid proof');
  expect(await db.prisma.closedSession.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
});
