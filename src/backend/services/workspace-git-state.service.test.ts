import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '@/backend/lib/shell';
import {
  getStats,
  WorkspaceGitStateService,
  type WorkspaceGitStateSnapshot,
} from './workspace-git-state.service';

type RunGit = (args: string[], cwd: string) => Promise<ExecResult>;

type WatchListener = (eventType: string, filename: string | null) => void;

interface TestWatcher {
  close(): void;
  closeMock: ReturnType<typeof vi.fn<() => void>>;
  listener: WatchListener;
  errorListener?: (error: Error) => void;
  on(event: 'error', listener: (error: Error) => void): TestWatcher;
}

function result(stdout = '', code = 0, stderr = ''): ExecResult {
  return { stdout, stderr, code };
}

function resolvedResult(stdout = '', code = 0, stderr = ''): Promise<ExecResult> {
  return Promise.resolve(result(stdout, code, stderr));
}

function isStatusCommand(args: string[]): boolean {
  return args.includes('status');
}

function defaultGitResult(args: string[]): ExecResult {
  if (isStatusCommand(args)) {
    return result(' M src/a.ts\n');
  }
  if (args[0] === 'merge-base') {
    return result('abc123\n');
  }
  if (args[0] === 'rev-parse') {
    return result('origin/feature\n');
  }
  if (args[1] === '--numstat') {
    return result('2\t1\tsrc/a.ts\n-\t-\timage.png\n');
  }
  if (args[1] === '--name-status') {
    return result('A\tnew.ts\nM\tchanged.ts\nD\tdeleted.ts\nR100\told.ts\tnew-name.ts\n');
  }
  if (args[1] === '--name-only') {
    return result('pushed-later.ts\n');
  }
  return result();
}

describe('WorkspaceGitStateService', () => {
  const input = { worktreePath: '/repo/w1', defaultBranch: 'main' };
  let runGit: ReturnType<typeof vi.fn<RunGit>>;
  let now: number;
  let readFile: ReturnType<typeof vi.fn<(filePath: string) => Promise<string>>>;
  let watchPath: ReturnType<
    typeof vi.fn<
      (filePath: string, options: { recursive: boolean }, listener: WatchListener) => TestWatcher
    >
  >;
  let watchers: Map<string, TestWatcher>;
  let service: WorkspaceGitStateService;

  beforeEach(() => {
    now = 1234;
    runGit = vi.fn<RunGit>((args) => Promise.resolve(defaultGitResult(args)));
    readFile = vi.fn((filePath) => {
      if (filePath === '/repo/w1/.git') {
        return Promise.resolve('gitdir: /repo/.git/worktrees/w1\n');
      }
      if (filePath === '/repo/.git/worktrees/w1/commondir') {
        return Promise.resolve('../..\n');
      }
      return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    });
    watchers = new Map();
    watchPath = vi.fn((filePath, _options, listener) => {
      const closeMock = vi.fn<() => void>();
      const watcher: TestWatcher = {
        close: closeMock,
        closeMock,
        listener,
        on(_event, errorListener) {
          this.errorListener = errorListener;
          return this;
        },
      };
      watchers.set(filePath, watcher);
      return watcher;
    });
    service = new WorkspaceGitStateService({ runGit, now: () => now, readFile, watchPath });
  });

  it('calculates a sectioned snapshot from one aggregate numstat command', async () => {
    const snapshot = await service.getSnapshot(input);

    expect(snapshot).toEqual<WorkspaceGitStateSnapshot>({
      ...input,
      computedAt: 1234,
      status: {
        files: [{ path: 'src/a.ts', status: 'M', staged: false }],
        hasUncommitted: true,
      },
      base: {
        mergeBase: 'abc123',
        noMergeBase: false,
        stats: { total: 2, additions: 2, deletions: 1, hasUncommitted: true },
        added: [
          { path: 'new.ts', status: 'added' },
          { path: 'new-name.ts', status: 'added' },
        ],
        modified: [{ path: 'changed.ts', status: 'modified' }],
        deleted: [
          { path: 'deleted.ts', status: 'deleted' },
          { path: 'old.ts', status: 'deleted' },
        ],
      },
      upstream: {
        ref: 'origin/feature',
        hasUpstream: true,
        files: ['pushed-later.ts'],
      },
    });
    expect(runGit).toHaveBeenCalledWith(
      ['--no-optional-locks', 'status', '--porcelain'],
      '/repo/w1'
    );
    expect(runGit).toHaveBeenCalledWith(['diff', '--numstat', 'abc123'], '/repo/w1');
    expect(runGit).toHaveBeenCalledWith(['diff', '--name-status', 'abc123'], '/repo/w1');
    expect(
      runGit.mock.calls.filter(([args]) => args[0] === 'diff' && args[1] === '--numstat')
    ).toHaveLength(1);
    expect(getStats(snapshot)).toEqual({
      total: 2,
      additions: 2,
      deletions: 1,
      hasUncommitted: true,
    });
  });

  it('shares one calculation for concurrent requests and reuses the warm result', async () => {
    const first = service.getSnapshot(input);
    const second = service.getSnapshot(input);

    expect(await second).toBe(await first);
    expect(await service.getSnapshot(input)).toBe(await first);
    expect(runGit.mock.calls.filter(([args]) => isStatusCommand(args))).toHaveLength(1);
  });

  it('reuses a degraded snapshot before its 5000 ms retry boundary', async () => {
    let statusAttempts = 0;
    runGit.mockImplementation((args) => {
      if (isStatusCommand(args) && statusAttempts++ === 0) {
        return resolvedResult('', 1, 'status temporarily unavailable');
      }
      return Promise.resolve(defaultGitResult(args));
    });

    const degraded = await service.getSnapshot(input);
    now += 4999;
    const cached = await service.getSnapshot(input);

    expect(degraded.status.error).toBe('status temporarily unavailable');
    expect(cached).toBe(degraded);
    expect(runGit.mock.calls.filter(([args]) => isStatusCommand(args))).toHaveLength(1);
  });

  it('recalculates a degraded snapshot at exactly 5000 ms', async () => {
    let statusAttempts = 0;
    runGit.mockImplementation((args) => {
      if (isStatusCommand(args) && statusAttempts++ === 0) {
        return resolvedResult('', 1, 'status temporarily unavailable');
      }
      return Promise.resolve(defaultGitResult(args));
    });

    const degraded = await service.getSnapshot(input);
    now += 4999;
    expect(await service.getSnapshot(input)).toBe(degraded);
    now += 1;
    const recovered = await service.getSnapshot(input);

    expect(recovered).not.toBe(degraded);
    expect(recovered.status.error).toBeUndefined();
    expect(recovered.status.files).toEqual([{ path: 'src/a.ts', status: 'M', staged: false }]);
    expect(runGit.mock.calls.filter(([args]) => isStatusCommand(args))).toHaveLength(2);
  });

  it('does not cache a calculation invalidated while it is in flight', async () => {
    const first = service.getSnapshot(input);
    service.invalidate('/repo/w1');

    await first;
    await service.getSnapshot(input);

    expect(runGit.mock.calls.filter(([args]) => isStatusCommand(args))).toHaveLength(2);
  });

  it('starts a fresh calculation for a caller arriving after invalidation', async () => {
    const statusResolvers: Array<(value: ExecResult) => void> = [];
    runGit.mockImplementation((args) => {
      if (isStatusCommand(args)) {
        return new Promise((resolve) => statusResolvers.push(resolve));
      }
      return Promise.resolve(defaultGitResult(args));
    });

    const first = service.getSnapshot(input);
    await vi.waitFor(() => expect(statusResolvers).toHaveLength(1));
    service.invalidate(input.worktreePath);

    const second = service.getSnapshot(input);
    await vi.waitFor(() => expect(statusResolvers).toHaveLength(2));
    expect(second).not.toBe(first);

    statusResolvers[0]?.(defaultGitResult(['status']));
    statusResolvers[1]?.(defaultGitResult(['status']));
    await Promise.all([first, second]);
  });

  it('does not restore a removed entry when an old calculation completes', async () => {
    const first = service.getSnapshot(input);
    service.remove('/repo/w1');

    await first;
    await service.getSnapshot(input);

    expect(runGit.mock.calls.filter(([args]) => isStatusCommand(args))).toHaveLength(2);
  });

  it('cleans a removal generation tombstone only after all detached calculations settle', async () => {
    const statusResolvers: Array<(value: ExecResult) => void> = [];
    runGit.mockImplementation((args) => {
      if (isStatusCommand(args)) {
        return new Promise((resolve) => statusResolvers.push(resolve));
      }
      return Promise.resolve(defaultGitResult(args));
    });

    const first = service.getSnapshot(input);
    await vi.waitFor(() => expect(statusResolvers).toHaveLength(1));
    service.remove(input.worktreePath);
    const second = service.getSnapshot(input);
    await vi.waitFor(() => expect(statusResolvers).toHaveLength(2));
    service.remove(input.worktreePath);

    statusResolvers[1]?.(defaultGitResult(['status']));
    await second;
    expect(service.getGenerationCount()).toBe(1);

    statusResolvers[0]?.(defaultGitResult(['status']));
    await first;
    expect(service.getGenerationCount()).toBe(0);
    expect(service.getCachedSnapshotCount()).toBe(0);
  });

  it('does not restore cached state after stop while a calculation is in flight', async () => {
    const first = service.getSnapshot(input);
    service.stop();

    await first;
    await service.getSnapshot(input);

    expect(runGit.mock.calls.filter(([args]) => isStatusCommand(args))).toHaveLength(2);
  });

  it('keeps default branches in separate cache entries', async () => {
    const main = await service.getSnapshot(input);
    const develop = await service.getSnapshot({ ...input, defaultBranch: 'develop' });

    expect(develop).not.toBe(main);
    expect(runGit.mock.calls.filter(([args]) => isStatusCommand(args))).toHaveLength(2);
  });

  it('invalidates snapshots for every worktree after shared refs change', async () => {
    const siblingInput = { worktreePath: '/repo/w2', defaultBranch: 'main' };
    const first = await service.getSnapshot(input);
    const sibling = await service.getSnapshot(siblingInput);

    service.invalidateAll();

    expect(await service.getSnapshot(input)).not.toBe(first);
    expect(await service.getSnapshot(siblingInput)).not.toBe(sibling);
  });

  it('watches the worktree, linked gitdir, and common Git metadata directory', async () => {
    await service.getSnapshot(input);

    expect([...watchers.keys()]).toEqual(['/repo/w1', '/repo/.git/worktrees/w1', '/repo/.git']);
    expect(watchPath).toHaveBeenCalledTimes(3);
    expect(watchPath.mock.calls.every(([, options]) => options.recursive)).toBe(true);
  });

  it('invalidates all base variants 100 ms after a watched file event', async () => {
    vi.useFakeTimers();
    try {
      const main = await service.getSnapshot(input);
      await service.getSnapshot({ ...input, defaultBranch: 'develop' });

      watchers.get('/repo/w1')?.listener('change', 'src/a.ts');
      await vi.advanceTimersByTimeAsync(99);
      expect(await service.getSnapshot(input)).toBe(main);
      await vi.advanceTimersByTimeAsync(1);

      expect(await service.getSnapshot(input)).not.toBe(main);
      expect(runGit.mock.calls.filter(([args]) => isStatusCommand(args))).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores top-level generated directories but invalidates nested names and Git metadata', async () => {
    vi.useFakeTimers();
    try {
      const first = await service.getSnapshot(input);

      watchers.get('/repo/w1')?.listener('change', 'dist/bundle.js');
      await vi.advanceTimersByTimeAsync(100);
      expect(await service.getSnapshot(input)).toBe(first);

      watchers.get('/repo/w1')?.listener('change', 'src/build/tracked.ts');
      await vi.advanceTimersByTimeAsync(100);
      const afterSourceChange = await service.getSnapshot(input);
      expect(afterSourceChange).not.toBe(first);

      watchers.get('/repo/.git')?.listener('change', 'refs/remotes/origin/main');
      await vi.advanceTimersByTimeAsync(100);
      expect(await service.getSnapshot(input)).not.toBe(afterSourceChange);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads only merge-base state for callers that do not need a full snapshot', async () => {
    await expect(service.getMergeBase(input)).resolves.toBe('abc123');

    expect(runGit).toHaveBeenCalledTimes(1);
    expect(runGit).toHaveBeenCalledWith(['merge-base', 'HEAD', 'origin/main'], '/repo/w1');
  });

  it('uses five-minute fallback expiry when recursive watcher setup fails', async () => {
    watchPath.mockImplementation(() => {
      throw new Error('recursive watching unsupported');
    });

    const first = await service.getSnapshot(input);
    now += 299_999;
    expect(await service.getSnapshot(input)).toBe(first);
    now += 1;
    expect(await service.getSnapshot(input)).not.toBe(first);
    expect(runGit.mock.calls.filter(([args]) => isStatusCommand(args))).toHaveLength(2);
  });

  it('switches to fallback expiry when an installed watcher emits an error', async () => {
    const first = await service.getSnapshot(input);
    watchers.get('/repo/.git')?.errorListener?.(new Error('watcher failed'));

    now += 300_000;

    expect(await service.getSnapshot(input)).not.toBe(first);
    expect(runGit.mock.calls.filter(([args]) => isStatusCommand(args))).toHaveLength(2);
  });

  it('does not expire warm entries while watchers remain healthy', async () => {
    const first = await service.getSnapshot(input);
    now += 3_000_000;

    expect(await service.getSnapshot(input)).toBe(first);
    expect(runGit.mock.calls.filter(([args]) => isStatusCommand(args))).toHaveLength(1);
  });

  it('closes watchers and clears all base variants on remove', async () => {
    await service.getSnapshot(input);
    await service.getSnapshot({ ...input, defaultBranch: 'develop' });
    const installedWatchers = [...watchers.values()];

    service.remove(input.worktreePath);

    expect(installedWatchers.every((watcher) => watcher.closeMock.mock.calls.length === 1)).toBe(
      true
    );
    expect(service.getCachedSnapshotCount()).toBe(0);
  });

  it('does not install watchers after remove while metadata resolution is in flight', async () => {
    let resolveGitFile!: (contents: string) => void;
    readFile.mockImplementation((filePath) => {
      if (filePath === '/repo/w1/.git') {
        return new Promise((resolve) => {
          resolveGitFile = resolve;
        });
      }
      return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    });
    service = new WorkspaceGitStateService({ runGit, now: () => now, readFile, watchPath });

    const calculation = service.getSnapshot(input);
    service.remove(input.worktreePath);
    resolveGitFile('gitdir: /repo/.git/worktrees/w1\n');
    await calculation;

    expect(watchPath).not.toHaveBeenCalled();
  });

  it('closes every watcher and clears cached snapshots on stop', async () => {
    await service.getSnapshot(input);
    const installedWatchers = [...watchers.values()];

    service.stop();

    expect(installedWatchers.every((watcher) => watcher.closeMock.mock.calls.length === 1)).toBe(
      true
    );
    expect(service.getCachedSnapshotCount()).toBe(0);
  });

  it('falls back to the local default branch when the origin merge base is unavailable', async () => {
    runGit.mockImplementation((args) => {
      if (isStatusCommand(args)) {
        return resolvedResult();
      }
      if (args[0] === 'merge-base' && args[2] === 'origin/main') {
        return resolvedResult('', 1);
      }
      if (args[0] === 'merge-base') {
        return resolvedResult('local-base\n');
      }
      if (args[0] === 'rev-parse') {
        return resolvedResult('', 1);
      }
      return resolvedResult();
    });

    const snapshot = await service.getSnapshot(input);

    expect(snapshot.base.mergeBase).toBe('local-base');
    expect(runGit).toHaveBeenCalledWith(['merge-base', 'HEAD', 'origin/main'], '/repo/w1');
    expect(runGit).toHaveBeenCalledWith(['merge-base', 'HEAD', 'main'], '/repo/w1');
  });

  it('computes aggregate unstaged stats and skips metadata when no merge base exists', async () => {
    runGit.mockImplementation((args) => {
      if (isStatusCommand(args)) {
        return resolvedResult('?? new.ts\n');
      }
      if (args[0] === 'merge-base' || args[0] === 'rev-parse') {
        return resolvedResult('', 1);
      }
      if (args[1] === '--numstat') {
        return resolvedResult('4\t0\tnew.ts\n');
      }
      return resolvedResult();
    });

    const snapshot = await service.getSnapshot(input);

    expect(snapshot.base).toEqual({
      mergeBase: null,
      noMergeBase: true,
      stats: { total: 1, additions: 4, deletions: 0, hasUncommitted: true },
      added: [],
      modified: [],
      deleted: [],
    });
    expect(runGit).toHaveBeenCalledWith(['diff', '--numstat'], '/repo/w1');
    expect(runGit.mock.calls.some(([args]) => args[1] === '--name-status')).toBe(false);
  });

  it('treats an upstream lookup failure as a missing upstream', async () => {
    runGit.mockImplementation((args) => {
      if (args[0] === 'rev-parse') {
        return resolvedResult('', 128, 'no upstream');
      }
      if (args[0] === 'merge-base') {
        return resolvedResult('abc123\n');
      }
      return resolvedResult();
    });

    const snapshot = await service.getSnapshot(input);

    expect(snapshot.upstream).toEqual({ ref: null, hasUpstream: false, files: [] });
  });

  it('keeps command errors in the section that failed', async () => {
    const resultsByCommand = new Map<string, ExecResult>([
      ['status', result('', 1, 'status broke')],
      ['merge-base', result('abc123\n')],
      ['rev-parse', result('origin/feature\n')],
      ['--numstat', result('1\t0\ta.ts\n')],
      ['--name-status', result('', 2, 'base diff broke')],
      ['--name-only', result('', 3, 'upstream diff broke')],
    ]);
    runGit.mockImplementation((args) => {
      const command = args[0] === 'diff' ? args[1] : isStatusCommand(args) ? 'status' : args[0];
      return Promise.resolve(resultsByCommand.get(command as string) ?? result());
    });

    const snapshot = await service.getSnapshot(input);

    expect(snapshot.status.error).toBe('status broke');
    expect(snapshot.base.changesError).toBe('base diff broke');
    expect(snapshot.upstream.error).toBe('upstream diff broke');
    expect(getStats(snapshot)).toBeNull();
  });

  it('keeps base change metadata available when aggregate stats fail', async () => {
    runGit.mockImplementation((args) => {
      if (args[1] === '--numstat') {
        return resolvedResult('', 2, 'stats diff broke');
      }
      return Promise.resolve(defaultGitResult(args));
    });

    const snapshot = await service.getSnapshot(input);

    expect(snapshot.base.stats).toBeNull();
    expect(snapshot.base.statsError).toBe('stats diff broke');
    expect(snapshot.base.changesError).toBeUndefined();
    expect(snapshot.base.added).toEqual([
      { path: 'new.ts', status: 'added' },
      { path: 'new-name.ts', status: 'added' },
    ]);
    expect(getStats(snapshot)).toBeNull();
  });

  it('keeps aggregate stats available when base change metadata fails', async () => {
    runGit.mockImplementation((args) => {
      if (args[1] === '--name-status') {
        return resolvedResult('', 2, 'change metadata broke');
      }
      return Promise.resolve(defaultGitResult(args));
    });

    const snapshot = await service.getSnapshot(input);

    expect(snapshot.base.changesError).toBe('change metadata broke');
    expect(snapshot.base.statsError).toBeUndefined();
    expect(getStats(snapshot)).toEqual({
      total: 2,
      additions: 2,
      deletions: 1,
      hasUncommitted: true,
    });
  });
});
