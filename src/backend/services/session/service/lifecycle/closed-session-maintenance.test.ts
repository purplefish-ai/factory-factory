import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as atomic from '@/backend/lib/atomic-file';
import { closedSessionPersistenceService as service } from './closed-session-persistence.service';
import { closedSessionWorkspaceDirectory } from './closed-session-storage';

const state = vi.hoisted(() => ({ root: '', running: vi.fn() }));
vi.mock('@/backend/services/config.service', () => ({
  configService: { getBaseDir: () => state.root },
}));
vi.mock('@/backend/lib/process-liveness', () => ({ isProcessRunning: state.running }));
vi.mock('@/backend/services/session/resources/closed-session.accessor', () => ({
  closedSessionAccessor: {
    findMaintenancePending: vi.fn(async () => []),
    findArtifactOwner: vi.fn(async () => ({ id: 'owned' })),
    reserve: vi.fn(async (data: Record<string, unknown>) => ({ ...data, archiveState: 'PENDING' })),
    complete: vi.fn(async () => undefined),
    removeOrphan: vi.fn(async () => undefined),
  },
}));

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'ff-archive-maintenance-'));
  state.running.mockResolvedValue(false);
});
afterEach(async () => {
  await service.stopArchiveMaintenance();
  vi.restoreAllMocks();
  await rm(state.root, { recursive: true, force: true });
});

async function temporaryFile(pid: number) {
  const dir = closedSessionWorkspaceDirectory('workspace');
  await mkdir(dir, { recursive: true });
  const name = `.tmp-archive-${pid}-${randomUUID()}`;
  await writeFile(join(dir, name), 'transcript');
  return { dir, name };
}

it('collects a tagged temporary transcript after its writer process exits', async () => {
  const { dir } = await temporaryFile(99_999_999);
  await service.maintainArchives();
  expect(await readdir(dir)).toEqual([]);
});

it('retains a temporary transcript while another writer process is alive', async () => {
  state.running.mockResolvedValue(true);
  const { dir, name } = await temporaryFile(99_999_999);
  await service.maintainArchives();
  expect(await readdir(dir)).toEqual([name]);
});

it('skips an active local atomic write and collects its abandoned temporary copy afterward', async () => {
  const original = atomic.writeFileAtomic;
  const dir = closedSessionWorkspaceDirectory('workspace');
  let release!: () => void;
  let entered!: () => void;
  let temporary = '';
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(atomic, 'writeFileAtomic').mockImplementationOnce(async (path, bytes, options) => {
    await mkdir(dir, { recursive: true });
    temporary = `.tmp-${options?.temporaryFileTag}-${randomUUID()}`;
    await writeFile(join(dir, temporary), bytes);
    entered();
    await gate;
    await original(path, bytes, options);
  });
  const close = service.persistClosedSession({
    sessionId: 'session',
    workspaceId: 'workspace',
    worktreePath: '/unused',
    name: null,
    workflow: 'followup',
    provider: 'CODEX',
    providerSessionId: 'thread',
    model: 'model',
    startedAt: new Date(0),
    messages: [],
  });
  await started;
  await service.maintainArchives();
  expect(await readdir(dir)).toContain(temporary);
  release();
  await close;
  await service.stopArchiveMaintenance();
  await service.maintainArchives();
  expect(await readdir(dir)).not.toContain(temporary);
});
