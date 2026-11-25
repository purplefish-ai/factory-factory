import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@/backend/lib/application-error';
import type { WorkspaceWithProject } from '@/backend/orchestration/types';
import {
  workspaceMaintenanceService,
  workspaceStateMachine,
  worktreeLifecycleService,
} from '@/backend/services/workspace';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  archiveWorkspace,
  type ArchiveWorkspaceDependencies,
  withArchiveExcluded,
} from './workspace-archive.orchestrator';

const persistence = vi.hoisted(() => ({
  findRawById: vi.fn<(id: string) => Promise<WorkspaceWithProject | null>>(),
  findRawByIdOrThrow: vi.fn<(id: string) => Promise<WorkspaceWithProject>>(),
  findByIdWithProject: vi.fn<(id: string) => Promise<WorkspaceWithProject | null>>(),
  transitionWithCas:
    vi.fn<
      (
        id: string,
        expectedStatus: WorkspaceWithProject['status'],
        data: { status: WorkspaceWithProject['status']; initErrorMessage?: string | null }
      ) => Promise<{ count: number }>
    >(),
}));

vi.mock('@/backend/services/workspace/resources/workspace.accessor', () => ({
  workspaceAccessor: persistence,
}));

vi.mock('@/backend/services/workspace/resources/workspace-archived-blobs.accessor', () => ({
  workspaceArchivedBlobsAccessor: { releaseOne: vi.fn().mockResolvedValue(1) },
}));

vi.mock('./workspace-children.orchestrator', () => ({
  fireLifecycleNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('concurrent workspace archives', () => {
  let row: WorkspaceWithProject;
  let services: ArchiveWorkspaceDependencies;

  beforeEach(() => {
    row = unsafeCoerce<WorkspaceWithProject>({
      id: 'archive-concurrency',
      name: 'Concurrent archive',
      status: 'READY',
      githubIssueNumber: null,
      prs: [],
      project: { id: 'project' },
    });
    persistence.findRawById.mockImplementation(async () => row);
    persistence.findRawByIdOrThrow.mockImplementation(async () => row);
    persistence.findByIdWithProject.mockImplementation(async () => row);
    persistence.transitionWithCas.mockImplementation((_id, expectedStatus, data) => {
      if (row.status !== expectedStatus) {
        return Promise.resolve({ count: 0 });
      }
      row = { ...row, ...data };
      return Promise.resolve({ count: 1 });
    });
    vi.spyOn(worktreeLifecycleService, 'snapshotWorkspaceWorktree').mockResolvedValue(undefined);
    vi.spyOn(worktreeLifecycleService, 'removeWorkspaceWorktree').mockResolvedValue(undefined);
    vi.spyOn(workspaceMaintenanceService, 'findStaleArchiving').mockResolvedValue([]);
    services = {
      cleanupWorkspaceScopedCaches: vi.fn(),
      githubCLIService: { addIssueComment: vi.fn() },
      runScriptService: {
        stopRunScript: vi.fn().mockResolvedValue({ success: true }),
        evictWorkspaceBuffers: vi.fn(),
      },
      sessionLifecycleService: { stopWorkspaceSessions: vi.fn().mockResolvedValue(undefined) },
      terminalService: { destroyWorkspaceTerminals: vi.fn() },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('joins pending cleanup for both fresh and stale duplicate requests', async () => {
    const enteredCleanup = deferred();
    const finishCleanup = deferred();
    vi.mocked(worktreeLifecycleService.snapshotWorkspaceWorktree).mockImplementation(async () => {
      enteredCleanup.resolve();
      await finishCleanup.promise;
    });
    const initialRow = row;
    const first = archiveWorkspace(initialRow, {}, services);
    await enteredCleanup.promise;
    const duplicate = archiveWorkspace(row, {}, services);
    const staleDuplicate = archiveWorkspace(initialRow, {}, services);
    const results = Promise.all([first, duplicate, staleDuplicate]);
    let settled = false;
    void duplicate.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(worktreeLifecycleService.snapshotWorkspaceWorktree).toHaveBeenCalledTimes(1);
    } finally {
      finishCleanup.resolve();
    }
    expect(await results).toEqual([
      expect.objectContaining({ status: 'ARCHIVED' }),
      expect.objectContaining({ status: 'ARCHIVED' }),
      expect.objectContaining({ status: 'ARCHIVED' }),
    ]);
    expect(services.cleanupWorkspaceScopedCaches).toHaveBeenCalledTimes(1);
  });

  it('shares a real cleanup failure and allows a later retry after rollback', async () => {
    const enteredCleanup = deferred();
    const finishCleanup = deferred();
    const error = new Error('Worktree cleanup failed');
    vi.mocked(worktreeLifecycleService.snapshotWorkspaceWorktree).mockImplementationOnce(
      async () => {
        enteredCleanup.resolve();
        await finishCleanup.promise;
        throw error;
      }
    );
    const first = archiveWorkspace(row, {}, services);
    await enteredCleanup.promise;
    const duplicate = archiveWorkspace(row, { removeGitIndexLock: true }, services);
    const results = Promise.allSettled([first, duplicate]);
    finishCleanup.resolve();
    expect(await results).toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error },
    ]);
    expect(row.status).toBe('READY');
    await expect(archiveWorkspace(row, {}, services)).resolves.toMatchObject({
      status: 'ARCHIVED',
    });
    expect(worktreeLifecycleService.snapshotWorkspaceWorktree).toHaveBeenCalledTimes(2);
  });

  it('retries an ARCHIVING snapshot after its previous owner failed and rolled back', async () => {
    let archivingSnapshot = row;
    vi.mocked(worktreeLifecycleService.snapshotWorkspaceWorktree).mockImplementationOnce(() => {
      archivingSnapshot = row;
      return Promise.reject(new Error('Worktree cleanup failed'));
    });
    await expect(archiveWorkspace(row, {}, services)).rejects.toThrow('Worktree cleanup failed');
    expect(archivingSnapshot.status).toBe('ARCHIVING');
    expect(row.status).toBe('READY');

    await expect(archiveWorkspace(archivingSnapshot, {}, services)).resolves.toMatchObject({
      status: 'ARCHIVED',
    });
    expect(worktreeLifecycleService.snapshotWorkspaceWorktree).toHaveBeenCalledTimes(2);
  });

  it('serializes explicit lock removal after an in-flight archive hits an index lock', async () => {
    const enteredCleanup = deferred();
    const finishCleanup = deferred();
    const error = new ApplicationError('CONFLICT', 'Git index is locked', {
      kind: 'GIT_INDEX_LOCKED',
    });
    vi.mocked(worktreeLifecycleService.snapshotWorkspaceWorktree).mockImplementationOnce(
      async () => {
        enteredCleanup.resolve();
        await finishCleanup.promise;
        throw error;
      }
    );
    const first = archiveWorkspace(row, {}, services);
    await enteredCleanup.promise;
    const recovery = archiveWorkspace(row, { removeGitIndexLock: true }, services);
    const results = Promise.allSettled([first, recovery]);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(worktreeLifecycleService.snapshotWorkspaceWorktree).toHaveBeenCalledTimes(1);
    } finally {
      finishCleanup.resolve();
    }
    expect(await results).toEqual([
      { status: 'rejected', reason: error },
      { status: 'fulfilled', value: expect.objectContaining({ status: 'ARCHIVED' }) },
    ]);
    expect(worktreeLifecycleService.snapshotWorkspaceWorktree).toHaveBeenCalledTimes(2);
    expect(worktreeLifecycleService.snapshotWorkspaceWorktree).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: row.id }),
      { removeGitIndexLock: true }
    );
  });

  it.each(['current', 'stale'] as const)(
    'resumes cleanup from a %s snapshot when a previous failure could not roll back',
    async (snapshot) => {
      const initialRow = row;
      const error = new Error('Worktree cleanup failed');
      vi.mocked(worktreeLifecycleService.snapshotWorkspaceWorktree).mockRejectedValueOnce(error);
      vi.spyOn(workspaceStateMachine, 'transition').mockRejectedValueOnce(
        new Error('Database unavailable')
      );
      await expect(archiveWorkspace(row, {}, services)).rejects.toBe(error);
      expect(row.status).toBe('ARCHIVING');

      await expect(
        archiveWorkspace(snapshot === 'stale' ? initialRow : row, {}, services)
      ).resolves.toMatchObject({
        status: 'ARCHIVED',
      });
      expect(worktreeLifecycleService.snapshotWorkspaceWorktree).toHaveBeenCalledTimes(2);
    }
  );

  it('moves forward after a removal failure, and the retry never snapshots again', async () => {
    vi.mocked(worktreeLifecycleService.removeWorkspaceWorktree).mockRejectedValueOnce(
      new Error('git worktree remove timed out')
    );
    await expect(archiveWorkspace(row, {}, services)).rejects.toThrow(
      'git worktree remove timed out'
    );
    expect(row).toMatchObject({
      status: 'FAILED',
      initErrorMessage:
        'Archive incomplete: git worktree remove timed out. Archive again to finish.',
    });

    await expect(archiveWorkspace(row, {}, services)).resolves.toMatchObject({
      status: 'ARCHIVED',
    });
    expect(worktreeLifecycleService.snapshotWorkspaceWorktree).toHaveBeenCalledTimes(1);
    expect(worktreeLifecycleService.removeWorkspaceWorktree).toHaveBeenCalledTimes(2);
  });

  it.each(['current', 'stale'] as const)(
    'resumes past the snapshot from a %s request when FAILED could not be written',
    async (snapshot) => {
      const initialRow = row;
      const error = new Error('git worktree remove timed out');
      vi.mocked(worktreeLifecycleService.removeWorkspaceWorktree).mockRejectedValueOnce(error);
      vi.spyOn(workspaceStateMachine, 'transition').mockRejectedValueOnce(
        new Error('Database unavailable')
      );
      await expect(archiveWorkspace(row, {}, services)).rejects.toBe(error);
      expect(row.status).toBe('ARCHIVING');

      await expect(
        archiveWorkspace(snapshot === 'stale' ? initialRow : row, {}, services)
      ).resolves.toMatchObject({ status: 'ARCHIVED' });
      expect(worktreeLifecycleService.snapshotWorkspaceWorktree).toHaveBeenCalledTimes(1);
      expect(worktreeLifecycleService.removeWorkspaceWorktree).toHaveBeenCalledTimes(2);
    }
  );

  it('does not take over a stale archive that could still belong to another process', async () => {
    row = { ...row, status: 'ARCHIVING', updatedAt: new Date(0) };
    vi.mocked(workspaceMaintenanceService.findStaleArchiving).mockResolvedValue([row]);
    await expect(archiveWorkspace(row, {}, services)).resolves.toMatchObject({
      status: 'ARCHIVING',
    });
    expect(worktreeLifecycleService.snapshotWorkspaceWorktree).not.toHaveBeenCalled();
    expect(persistence.transitionWithCas).not.toHaveBeenCalled();
  });

  it('retries a transition lost to an archive that rolled back', async () => {
    persistence.transitionWithCas.mockImplementationOnce(() => {
      row = { ...row, status: 'FAILED' };
      return Promise.resolve({ count: 0 });
    });
    await expect(archiveWorkspace(row, {}, services)).resolves.toMatchObject({
      status: 'ARCHIVED',
    });
    expect(worktreeLifecycleService.snapshotWorkspaceWorktree).toHaveBeenCalledTimes(1);
  });

  it('stops retrying when another owner keeps winning the transition', async () => {
    persistence.transitionWithCas.mockResolvedValue({ count: 0 });
    await expect(archiveWorkspace(row, {}, services)).rejects.toThrow(
      'status changed by another process'
    );
    expect(persistence.transitionWithCas).toHaveBeenCalledTimes(2);
    expect(worktreeLifecycleService.snapshotWorkspaceWorktree).not.toHaveBeenCalled();
  });

  it.each(['ARCHIVING', 'ARCHIVED'] as const)(
    'quietly accepts an already %s workspace',
    async (status) => {
      row = { ...row, status };
      await expect(archiveWorkspace(row, {}, services)).resolves.toMatchObject({ status });
      expect(persistence.transitionWithCas).not.toHaveBeenCalled();
      expect(worktreeLifecycleService.snapshotWorkspaceWorktree).not.toHaveBeenCalled();
      expect(services.sessionLifecycleService.stopWorkspaceSessions).not.toHaveBeenCalled();
    }
  );

  it.each(['ARCHIVING', 'ARCHIVED'] as const)(
    'accepts a stale READY request after the row becomes %s',
    async (status) => {
      const initialRow = row;
      row = { ...row, status };
      await expect(archiveWorkspace(initialRow, {}, services)).resolves.toMatchObject({ status });
      expect(worktreeLifecycleService.snapshotWorkspaceWorktree).not.toHaveBeenCalled();
    }
  );

  it('accepts an archive completed by another owner during the conditional transition', async () => {
    persistence.transitionWithCas.mockImplementationOnce(() => {
      row = { ...row, status: 'ARCHIVED' };
      return Promise.resolve({ count: 0 });
    });
    await expect(archiveWorkspace(row, {}, services)).resolves.toMatchObject({
      status: 'ARCHIVED',
    });
    expect(worktreeLifecycleService.snapshotWorkspaceWorktree).not.toHaveBeenCalled();
  });

  it('preserves a transition conflict unrelated to archiving', async () => {
    persistence.transitionWithCas.mockImplementationOnce(() => {
      row = { ...row, status: 'PROVISIONING' };
      return Promise.resolve({ count: 0 });
    });
    await expect(archiveWorkspace(row, {}, services)).rejects.toThrow(
      'status changed by another process'
    );
    expect(worktreeLifecycleService.snapshotWorkspaceWorktree).not.toHaveBeenCalled();
  });

  it('preserves unexpected failures starting an archive', async () => {
    const error = new Error('Database unavailable');
    vi.spyOn(workspaceStateMachine, 'startArchivingWithSourceStatus').mockRejectedValueOnce(error);
    await expect(archiveWorkspace(row, {}, services)).rejects.toBe(error);
  });

  it.each([
    ['succeeds', undefined],
    ['fails', new Error('Worktree cleanup failed')],
  ])('runs an excluded operation only once the in-flight archive %s', async (_outcome, failure) => {
    await expect(withArchiveExcluded(row.id, async () => 'idle')).resolves.toBe('idle');
    const enteredCleanup = deferred();
    const finishCleanup = deferred();
    vi.mocked(worktreeLifecycleService.cleanupWorkspaceWorktree).mockImplementationOnce(
      async () => {
        enteredCleanup.resolve();
        await finishCleanup.promise;
        if (failure) {
          throw failure;
        }
      }
    );
    const archive = archiveWorkspace(row, {}, services).catch((error: unknown) => error);
    await enteredCleanup.promise;
    const operation = vi.fn(async () => 'deleted');
    const excluded = withArchiveExcluded(row.id, operation);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(operation).not.toHaveBeenCalled();
    finishCleanup.resolve();
    await expect(excluded).resolves.toBe('deleted');
    expect(await archive).toEqual(failure ?? expect.objectContaining({ status: 'ARCHIVED' }));
  });

  it('refuses an archive that starts while an excluded operation runs', async () => {
    const release = deferred();
    const excluded = withArchiveExcluded(row.id, () => release.promise);
    await expect(archiveWorkspace(row, {}, services)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Workspace is being deleted',
    });
    expect(worktreeLifecycleService.cleanupWorkspaceWorktree).not.toHaveBeenCalled();
    release.resolve();
    await excluded;
    await expect(archiveWorkspace(row, {}, services)).resolves.toMatchObject({
      status: 'ARCHIVED',
    });
  });

  it('never runs an excluded operation alongside a joined lock-recovery retry', async () => {
    const enteredCleanup = deferred();
    const finishCleanup = deferred();
    let cleaning = 0;
    vi.mocked(worktreeLifecycleService.cleanupWorkspaceWorktree)
      .mockImplementationOnce(async () => {
        cleaning++;
        enteredCleanup.resolve();
        await finishCleanup.promise;
        cleaning--;
        throw new ApplicationError('CONFLICT', 'Index locked', { kind: 'GIT_INDEX_LOCKED' });
      })
      .mockImplementationOnce(async () => {
        cleaning++;
        await new Promise<void>((resolve) => setImmediate(resolve));
        cleaning--;
      });
    const owner = archiveWorkspace(row, {}, services).catch((error: unknown) => error);
    await enteredCleanup.promise;
    const recovery = archiveWorkspace(row, { removeGitIndexLock: true }, services).catch(
      (error: unknown) => error
    );
    const seen: number[] = [];
    const excluded = withArchiveExcluded(row.id, async () => {
      seen.push(cleaning);
      await new Promise<void>((resolve) => setImmediate(resolve));
      seen.push(cleaning);
    });

    finishCleanup.resolve();
    await excluded;
    await Promise.all([owner, recovery]);
    expect(seen).toEqual([0, 0]);
    // The retry ran first, so the exclusion waited for it rather than refusing it.
    expect(worktreeLifecycleService.cleanupWorkspaceWorktree).toHaveBeenCalledTimes(2);
  });
});
