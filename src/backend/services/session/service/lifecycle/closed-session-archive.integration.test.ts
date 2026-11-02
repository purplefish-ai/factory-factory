import { unlinkSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { PersistClosedSessionInput } from './closed-session-persistence.service';

let db: IntegrationDatabase;
let service: typeof import('./closed-session-persistence.service').closedSessionPersistenceService;
let accessor: typeof import('../../resources/closed-session.accessor').closedSessionAccessor;
let atomic: typeof import('@/backend/lib/atomic-file');
let input: PersistClosedSessionInput;
let config: typeof import('@/backend/services/config.service').configService;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  const { configService } = await vi.importActual<
    typeof import('@/backend/services/config.service')
  >('@/backend/services/config.service');
  config = configService;
  ({ closedSessionPersistenceService: service } = await vi.importActual<
    typeof import('./closed-session-persistence.service')
  >('./closed-session-persistence.service'));
  ({ closedSessionAccessor: accessor } = await vi.importActual<
    typeof import('../../resources/closed-session.accessor')
  >('../../resources/closed-session.accessor'));
  atomic = await vi.importActual<typeof import('@/backend/lib/atomic-file')>(
    '@/backend/lib/atomic-file'
  );
}, 30_000);
beforeEach(async () => {
  vi.spyOn(config, 'getBaseDir').mockReturnValue(db.tempDir);
  const project = await db.prisma.project.create({
    data: { name: 'test', slug: 'archive', repoPath: '/repo', worktreeBasePath: '/worktrees' },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'workspace',
      name: 'test',
      projectId: project.id,
      worktreePath: join(db.tempDir, 'worktree'),
    },
  });
  input = {
    sessionId: 'session',
    workspaceId: 'workspace',
    worktreePath: join(db.tempDir, 'worktree'),
    name: 'chat',
    workflow: 'followup',
    provider: 'CODEX',
    codexAccountId: 'account',
    providerSessionId: 'thread',
    model: 'model',
    startedAt: new Date('2026-01-01'),
    messages: [
      { id: 'm', source: 'user', text: 'hello', timestamp: '2026-01-01T00:00:00Z', order: 0 },
    ],
  };
});
afterEach(async () => {
  await service.stopArchiveMaintenance();
  vi.restoreAllMocks();
  await clearIntegrationDatabase(db.prisma);
  await rm(join(db.tempDir, 'closed-sessions'), { recursive: true, force: true });
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

it('concurrent close and retry share one immutable archive outside the worktree', async () => {
  await Promise.all([service.persistClosedSession(input), service.persistClosedSession(input)]);
  await service.persistClosedSession(input);
  const rows = await accessor.findByWorkspaceId('workspace', 20);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.transcriptPath).toMatch(/^closed-sessions\//);
  await rm(input.worktreePath, { recursive: true, force: true });
  const { resolveClosedSessionTranscriptPath } = await vi.importActual<
    typeof import('@/backend/services/session/service/lifecycle/closed-session-storage')
  >('@/backend/services/session/service/lifecycle/closed-session-storage');
  const row = rows[0]!;
  expect(
    JSON.parse(await readFile(resolveClosedSessionTranscriptPath(row, null), 'utf8')).messages
  ).toEqual(input.messages);
});

it('rejects invalid archive states at the SQLite boundary', async () => {
  await service.persistClosedSession(input);
  const row = await db.prisma.closedSession.findFirstOrThrow();
  await expect(
    db.prisma.closedSession.update({ where: { id: row.id }, data: { archiveState: 'UNKNOWN' } })
  ).rejects.toThrow();
  expect(
    (await db.prisma.closedSession.findUniqueOrThrow({ where: { id: row.id } })).archiveState
  ).toBe('COMPLETE');
});

it('recovers a pending archive before looking for an archived PR receipt', async () => {
  const write = vi.spyOn(atomic, 'writeFileAtomic').mockRejectedValueOnce(new Error('disk failed'));
  await expect(
    service.persistClosedSession({ ...input, provider: 'CLAUDE', codexAccountId: null })
  ).rejects.toThrow('disk failed');
  expect(write).toHaveBeenCalledOnce();
  write.mockRestore();
  const { claudeSessionHistoryLoaderService } = await vi.importActual<
    typeof import('../data/session-history-loader.service')
  >('../data/session-history-loader.service');
  vi.spyOn(claudeSessionHistoryLoaderService, 'loadSessionHistory').mockResolvedValue({
    status: 'loaded',
    filePath: '/fixture',
    history: [
      {
        type: 'user',
        content: '<!-- factory-factory-pr-event:delivery -->',
        timestamp: '2026-01-01',
      },
    ],
  });
  const { findPRDeliveryReceipt } =
    await vi.importActual<typeof import('./session-pr-receipt')>('./session-pr-receipt');
  expect(await findPRDeliveryReceipt(input.sessionId, 'delivery')).toBe('delivered');
  expect((await db.prisma.closedSession.findFirstOrThrow()).archiveState).toBe('COMPLETE');
});

it('reports unavailable rather than absent while pending PR receipt proof cannot recover', async () => {
  await db.prisma.agentSession.create({
    data: {
      id: input.sessionId,
      workspaceId: input.workspaceId,
      provider: 'CLAUDE',
      providerSessionId: 'thread',
      model: 'model',
      workflow: 'followup',
    },
  });
  const write = vi.spyOn(atomic, 'writeFileAtomic').mockRejectedValue(new Error('disk failed'));
  await expect(
    service.persistClosedSession({ ...input, provider: 'CLAUDE', codexAccountId: null })
  ).rejects.toThrow('disk failed');
  const { claudeSessionHistoryLoaderService } = await vi.importActual<
    typeof import('../data/session-history-loader.service')
  >('../data/session-history-loader.service');
  vi.spyOn(claudeSessionHistoryLoaderService, 'loadSessionHistory').mockResolvedValue({
    status: 'loaded',
    filePath: '/fixture',
    history: [],
  });
  const { findPRDeliveryReceipt } =
    await vi.importActual<typeof import('./session-pr-receipt')>('./session-pr-receipt');
  expect(await findPRDeliveryReceipt(input.sessionId, 'delivery')).toBe('unavailable');
  expect(write).toHaveBeenCalledTimes(2);
  expect((await db.prisma.closedSession.findFirstOrThrow()).archiveState).toBe('PENDING');
});

it('recovers a pending write after failure without advertising an incomplete transcript', async () => {
  const write = vi.spyOn(atomic, 'writeFileAtomic').mockRejectedValueOnce(new Error('disk full'));
  await expect(service.persistClosedSession(input)).rejects.toThrow('disk full');
  expect(await db.prisma.closedSession.count()).toBe(1);
  expect(await accessor.findByWorkspaceId('workspace', 20)).toEqual([]);
  write.mockRestore();
  await service.recoverPending('workspace');
  expect(await accessor.findByWorkspaceId('workspace', 20)).toHaveLength(1);
});

it('recovers after file rename but before database completion using the original payload', async () => {
  const complete = vi
    .spyOn(accessor, 'complete')
    .mockRejectedValueOnce(new Error('DB unavailable'));
  await expect(service.persistClosedSession(input)).rejects.toThrow('DB unavailable');
  expect(await accessor.findByWorkspaceId('workspace', 20)).toEqual([]);
  const pending = await db.prisma.closedSession.findFirstOrThrow();
  const { resolveClosedSessionTranscriptPath } = await vi.importActual<
    typeof import('./closed-session-storage')
  >('./closed-session-storage');
  const bytes = await readFile(resolveClosedSessionTranscriptPath(pending, null), 'utf8');
  expect(JSON.parse(bytes).messages).toEqual(input.messages);
  complete.mockRestore();
  await service.recoverPending('workspace');
  expect(await accessor.findByWorkspaceId('workspace', 20)).toHaveLength(1);
  expect(await readFile(resolveClosedSessionTranscriptPath(pending, null), 'utf8')).toBe(bytes);
  await service.persistClosedSession(input);
  expect(await db.prisma.closedSession.count()).toBe(1);
});

it('distinguishes provider, account, rollover identity and later snapshots', async () => {
  for (const override of [
    {},
    { codexAccountId: 'other' },
    { providerSessionId: 'replacement' },
    { provider: 'CLAUDE' as const },
    { messages: [...input.messages, { ...input.messages[0]!, id: 'later' }] },
  ]) {
    await service.persistClosedSession({ ...input, ...override });
  }
  expect(await db.prisma.closedSession.count()).toBe(5);
});

it('database reservation failure does not create an orphan transcript', async () => {
  vi.spyOn(accessor, 'reserve').mockRejectedValueOnce(new Error('DB unavailable'));
  const write = vi.spyOn(atomic, 'writeFileAtomic');
  await expect(service.persistClosedSession(input)).rejects.toThrow('DB unavailable');
  expect(write).not.toHaveBeenCalled();
});

it('moves legacy proof before worktree removal, retaining its original ID and bytes', async () => {
  const { mkdir, writeFile } =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  await mkdir(input.worktreePath, { recursive: true });
  const original = JSON.stringify({
    version: 1,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    metadata: {
      ...input,
      startedAt: input.startedAt.toISOString(),
      completedAt: new Date().toISOString(),
    },
    messages: input.messages,
  });
  await writeFile(join(input.worktreePath, 'legacy.json'), original);
  const legacy = await db.prisma.closedSession.create({
    data: {
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      name: input.name,
      workflow: input.workflow,
      provider: input.provider,
      model: input.model,
      startedAt: input.startedAt,
      transcriptPath: 'legacy.json',
    },
  });
  await service.preserveWorkspaceArchives('workspace');
  expect(await readFile(join(input.worktreePath, 'legacy.json'), 'utf8')).toBe(original);
  await rm(input.worktreePath, { recursive: true, force: true });
  const row = await accessor.findByIdWithWorkspace(legacy.id);
  const { resolveClosedSessionTranscriptPath } = await vi.importActual<
    typeof import('@/backend/services/session/service/lifecycle/closed-session-storage')
  >('@/backend/services/session/service/lifecycle/closed-session-storage');
  expect(await readFile(resolveClosedSessionTranscriptPath(row!, null), 'utf8')).toBe(original);
});

it('keeps a legacy original if relocation fails and resumes after restart', async () => {
  const { mkdir, writeFile } =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  await mkdir(input.worktreePath, { recursive: true });
  await writeFile(join(input.worktreePath, 'legacy.json'), '{"messages":[]}');
  await db.prisma.closedSession.create({
    data: {
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      name: input.name,
      workflow: input.workflow,
      provider: input.provider,
      model: input.model,
      startedAt: input.startedAt,
      transcriptPath: 'legacy.json',
    },
  });
  const write = vi.spyOn(atomic, 'writeFileAtomic').mockRejectedValueOnce(new Error('disk full'));
  await expect(service.preserveWorkspaceArchives('workspace')).rejects.toThrow('disk full');
  expect(await readFile(join(input.worktreePath, 'legacy.json'), 'utf8')).toBe('{"messages":[]}');
  write.mockRestore();
  await service.recoverPending('workspace');
  const rows = await accessor.findByWorkspaceId('workspace', 20);
  expect(rows).toHaveLength(1);
  const { resolveClosedSessionTranscriptPath } = await vi.importActual<
    typeof import('./closed-session-storage')
  >('./closed-session-storage');
  expect(await readFile(resolveClosedSessionTranscriptPath(rows[0]!, null), 'utf8')).toBe(
    '{"messages":[]}'
  );
});

it('explicit workspace deletion cascades records and removes owned artifacts', async () => {
  await service.persistClosedSession(input);
  const row = await db.prisma.closedSession.findFirstOrThrow();
  const { resolveClosedSessionTranscriptPath } = await vi.importActual<
    typeof import('./closed-session-storage')
  >('./closed-session-storage');
  const path = resolveClosedSessionTranscriptPath(row, null);
  expect(JSON.parse(await readFile(path, 'utf8')).messages).toEqual(input.messages);
  const { workspaceDataService } = await vi.importActual<
    typeof import('@/backend/services/workspace')
  >('@/backend/services/workspace');
  workspaceDataService.configureDeletionCapture(
    async () => undefined,
    (id) => service.cleanupDeletedWorkspace(id)
  );
  await workspaceDataService.delete('workspace');
  expect(await db.prisma.closedSession.count()).toBe(0);
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('late file publication after workspace deletion cannot publish or leak a transcript', async () => {
  const original = atomic.writeFileAtomic;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(atomic, 'writeFileAtomic').mockImplementationOnce(async (...args) => {
    entered();
    await gate;
    await original(...args);
  });
  const close = Promise.allSettled([service.persistClosedSession(input)]);
  await started;
  const { workspaceDataService } = await vi.importActual<
    typeof import('@/backend/services/workspace')
  >('@/backend/services/workspace');
  workspaceDataService.configureDeletionCapture(
    async () => undefined,
    (id) => service.cleanupDeletedWorkspace(id)
  );
  const deletion = workspaceDataService.delete('workspace');
  await deletion;
  release();
  await close;
  expect(await db.prisma.closedSession.count()).toBe(0);
  const { readdir } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const { closedSessionWorkspaceDirectory } = await vi.importActual<
    typeof import('@/backend/services/session/service/lifecycle/closed-session-storage')
  >('@/backend/services/session/service/lifecycle/closed-session-storage');
  const files = await readdir(closedSessionWorkspaceDirectory('workspace')).catch(
    (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  );
  expect(files).toEqual([]);
});

it('distinguishes a repeated provider ID in a later conversation epoch', async () => {
  await service.persistClosedSession({ ...input, ...{ conversationEpoch: 0 } });
  await service.persistClosedSession({ ...input, ...{ conversationEpoch: 2 } });
  expect(await db.prisma.closedSession.count()).toBe(2);
});

it('cleans orphaned owned files during maintenance while preserving committed and pending proof', async () => {
  await service.persistClosedSession(input);
  const row = (await accessor.findByWorkspaceId('workspace', 20))[0]!;
  await db.prisma.closedSession.delete({ where: { id: row.id } });
  await service.persistClosedSession({ ...input, sessionId: 'committed-proof' });
  const committed = await db.prisma.closedSession.findFirstOrThrow({
    where: { sessionId: 'committed-proof' },
  });
  const { resolveClosedSessionTranscriptPath } = await vi.importActual<
    typeof import('./closed-session-storage')
  >('./closed-session-storage');
  const committedBytes = await readFile(
    resolveClosedSessionTranscriptPath(committed, null),
    'utf8'
  );
  const complete = vi
    .spyOn(accessor, 'complete')
    .mockRejectedValueOnce(new Error('DB unavailable'));
  await expect(
    service.persistClosedSession({ ...input, sessionId: 'pending-proof' })
  ).rejects.toThrow('DB unavailable');
  complete.mockRestore();
  const pending = await db.prisma.closedSession.findFirstOrThrow({
    where: { sessionId: 'pending-proof' },
  });
  expect(pending.archiveState).toBe('PENDING');
  const pendingBytes = await readFile(resolveClosedSessionTranscriptPath(pending, null), 'utf8');
  const write = vi
    .spyOn(atomic, 'writeFileAtomic')
    .mockRejectedValue(new Error('disk unavailable'));
  await service.maintainArchives();
  expect(write).toHaveBeenCalledOnce();
  expect(await readFile(resolveClosedSessionTranscriptPath(committed, null), 'utf8')).toBe(
    committedBytes
  );
  expect(await readFile(resolveClosedSessionTranscriptPath(pending, null), 'utf8')).toBe(
    pendingBytes
  );
  expect(
    (await db.prisma.closedSession.findUniqueOrThrow({ where: { id: pending.id } }))
      .pendingTranscript
  ).toBe(pendingBytes);
  await expect(readFile(resolveClosedSessionTranscriptPath(row, null))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('does not resurrect a removed reservation or overwrite a newly completed copy', async () => {
  const original = atomic.writeFileAtomic;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(atomic, 'writeFileAtomic').mockImplementationOnce(async (...args) => {
    entered();
    await gate;
    await original(...args);
  });
  const first = service.persistClosedSession(input);
  await started;
  const removed = await db.prisma.closedSession.findFirstOrThrow();
  const removal = accessor.delete(removed.id);
  const replacement = removal.then(() => service.persistClosedSession(input));
  // A correct completion lock makes deletion wait until its file is published.
  release();
  await Promise.allSettled([first, replacement]);
  const rows = await accessor.findByWorkspaceId('workspace', 20);
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.id).not.toBe(removed.id);
  const { archiveDigest, resolveClosedSessionTranscriptPath } = await vi.importActual<
    typeof import('@/backend/services/session/service/lifecycle/closed-session-storage')
  >('@/backend/services/session/service/lifecycle/closed-session-storage');
  expect(archiveDigest(await readFile(resolveClosedSessionTranscriptPath(row, null), 'utf8'))).toBe(
    row.transcriptHash
  );
});

it('re-reservation after collection uses a distinct immutable artifact generation', async () => {
  await service.persistClosedSession(input);
  const row = (await accessor.findByWorkspaceId('workspace', 20))[0]!;
  await accessor.delete(row.id);
  const { resolveClosedSessionTranscriptPath } = await vi.importActual<
    typeof import('@/backend/services/session/service/lifecycle/closed-session-storage')
  >('@/backend/services/session/service/lifecycle/closed-session-storage');
  const oldPath = resolveClosedSessionTranscriptPath(row, null);
  await accessor.removeOrphan(row.id, row.transcriptHash!, row.transcriptPath, () =>
    unlinkSync(oldPath)
  );
  await service.persistClosedSession(input);
  const replacement = (await accessor.findByWorkspaceId('workspace', 20))[0]!;
  expect(replacement.archiveKey).toBe(row.archiveKey);
  expect(replacement.transcriptPath).not.toBe(row.transcriptPath);
  await expect(
    readFile(resolveClosedSessionTranscriptPath(replacement, null))
  ).resolves.toBeDefined();
  await expect(readFile(oldPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('advances bounded orphan cleanup beyond a retained first page', async () => {
  const { mkdir, writeFile } =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const { closedSessionWorkspaceDirectory, closedSessionArchivePath } = await vi.importActual<
    typeof import('@/backend/services/session/service/lifecycle/closed-session-storage')
  >('@/backend/services/session/service/lifecycle/closed-session-storage');
  const dir = closedSessionWorkspaceDirectory('workspace');
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < 120; i++) {
    const key = i.toString(16).padStart(64, '0');
    await db.prisma.closedSession.create({
      data: {
        id: `retained-${i}`,
        transcriptHash: key,
        workspaceId: 'workspace',
        sessionId: 'session',
        workflow: 'followup',
        provider: 'CODEX',
        model: 'm',
        startedAt: input.startedAt,
        archiveKey: key,
        transcriptPath: closedSessionArchivePath('workspace', `retained-${i}`, key),
      },
    });
    await writeFile(join(dir, `${`retained-${i}`}.${key}.json`), '{}');
  }
  const { opendir } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const names: string[] = [];
  for await (const entry of await opendir(dir)) {
    names.push(entry.name);
  }
  const orphanName = names.at(-1)!;
  const orphan = join(dir, orphanName);
  await db.prisma.closedSession.delete({ where: { id: orphanName.split('.')[0] } });
  for (let i = 0; i < 3; i++) {
    await service.maintainArchives();
  }
  await expect(readFile(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await db.prisma.closedSession.count()).toBe(119);
}, 20_000);

it('retains best-effort individual deletion when artifact cleanup is temporarily unavailable', async () => {
  await service.persistClosedSession(input);
  const row = (await accessor.findByWorkspaceId('workspace', 20))[0]!;
  const { sessionDataService } = await vi.importActual<
    typeof import('../data/session-data.service')
  >('../data/session-data.service');
  const cleanup = vi
    .spyOn(accessor, 'removeOrphan')
    .mockRejectedValueOnce(new Error('DB unavailable after deletion'));
  await expect(sessionDataService.deleteClosedSession(row.id)).resolves.toMatchObject({
    id: row.id,
  });
  expect(await db.prisma.closedSession.count()).toBe(0);
  cleanup.mockRestore();
  await service.maintainArchives();
  const { resolveClosedSessionTranscriptPath } = await vi.importActual<
    typeof import('@/backend/services/session/service/lifecycle/closed-session-storage')
  >('@/backend/services/session/service/lifecycle/closed-session-storage');
  await expect(readFile(resolveClosedSessionTranscriptPath(row, null))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('keeps an individually deleted row deleted on the shared SQLite connection', async () => {
  const failure = vi.spyOn(atomic, 'writeFileAtomic').mockRejectedValueOnce(new Error('disk full'));
  await expect(service.persistClosedSession(input)).rejects.toThrow('disk full');
  failure.mockRestore();
  const pending = await db.prisma.closedSession.findFirstOrThrow();
  const original = atomic.writeFileAtomic;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(atomic, 'writeFileAtomic').mockImplementationOnce(async (...args) => {
    entered();
    await gate;
    await original(...args);
  });
  const finish = service.recoverById(pending.id);
  const finishResult = Promise.allSettled([finish]);
  await started;
  const deletion = accessor.delete(pending.id);
  // Ordinary reads share the adapter connection; allow the deletion request to
  // reach the adapter while the completion transaction awaits filesystem I/O.
  await db.prisma.closedSession.findUnique({ where: { id: pending.id } });
  release();
  await Promise.all([finishResult, deletion]);
  expect(await db.prisma.closedSession.findUnique({ where: { id: pending.id } })).toBeNull();
});

it('does not roll back an unrelated accepted write when the archive filesystem fails', async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(atomic, 'writeFileAtomic').mockImplementationOnce(async () => {
    entered();
    await gate;
    throw new Error('disk full');
  });
  const close = service.persistClosedSession(input);
  const closeResult = Promise.allSettled([close]);
  await started;
  await db.prisma.workspace.update({
    where: { id: 'workspace' },
    data: { name: 'accepted rename' },
  });
  release();
  expect(await closeResult).toMatchObject([
    { status: 'rejected', reason: { message: 'disk full' } },
  ]);
  expect((await db.prisma.workspace.findUniqueOrThrow({ where: { id: 'workspace' } })).name).toBe(
    'accepted rename'
  );
});

it('retains exact internal prompt evidence while renderer projection removes it', async () => {
  const prompt = [
    { type: 'text' as const, text: 'first' },
    {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png', data: 'aGk=' },
    },
    { type: 'text' as const, text: 'second' },
  ];
  input.messages[0]!.providerPrompt = prompt;
  await service.persistClosedSession(input);
  const row = await accessor.findByIdWithWorkspace(
    (await accessor.findByWorkspaceId('workspace', 20))[0]!.id
  );
  const { resolveClosedSessionTranscriptPath } = await vi.importActual<
    typeof import('./closed-session-storage')
  >('./closed-session-storage');
  const original = await service.readTranscript(
    row!,
    resolveClosedSessionTranscriptPath(row!, null)
  );
  expect(JSON.parse(original).messages).toEqual(input.messages);
  expect(await readFile(resolveClosedSessionTranscriptPath(row!, null), 'utf8')).toBe(original);
});

it('refuses workspace archival when legacy source bytes are missing without altering the row', async () => {
  const row = await db.prisma.closedSession.create({
    data: {
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      name: input.name,
      workflow: input.workflow,
      provider: input.provider,
      model: input.model,
      startedAt: input.startedAt,
      transcriptPath: 'unavailable-legacy.json',
    },
  });
  await expect(service.preserveWorkspaceArchives('workspace')).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await db.prisma.closedSession.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
  expect(await db.prisma.workspace.findUnique({ where: { id: 'workspace' } })).not.toBeNull();
});
