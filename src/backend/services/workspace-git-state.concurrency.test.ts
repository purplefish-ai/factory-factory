import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '@/backend/lib/shell';
import { WorkspaceGitStateService } from './workspace-git-state.service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function result(args: string[]): ExecResult {
  const stdout = args.includes('status')
    ? ' M changed.ts\n'
    : args[0] === 'merge-base'
      ? 'base\n'
      : args[0] === 'rev-parse'
        ? 'origin/feature\n'
        : args[1] === '--numstat'
          ? '3\t1\tchanged.ts\n'
          : args[1] === '--name-status'
            ? 'M\tchanged.ts\n'
            : 'committed.ts\n';
  return { stdout, stderr: '', code: 0 };
}

const input = { worktreePath: '/repo/worktree', defaultBranch: 'main' };
const watcherOptions = {
  readFile: () => Promise.reject(Object.assign(new Error('directory'), { code: 'EISDIR' })),
  watchPath: () => ({
    close() {
      /* No real watcher to close. */
    },
    on() {
      return this;
    },
  }),
};

function expectSnapshot(snapshot: Awaited<ReturnType<WorkspaceGitStateService['getSnapshot']>>) {
  expect(snapshot.status).toEqual({
    files: [{ path: 'changed.ts', status: 'M', staged: false }],
    hasUncommitted: true,
  });
  expect(snapshot.base).toEqual({
    mergeBase: 'base',
    noMergeBase: false,
    stats: { total: 1, additions: 3, deletions: 1, hasUncommitted: true },
    added: [],
    modified: [{ path: 'changed.ts', status: 'modified' }],
    deleted: [],
  });
  expect(snapshot.upstream).toEqual({
    ref: 'origin/feature',
    hasUpstream: true,
    files: ['committed.ts'],
  });
}

async function drainCommands(pending: Array<() => void>) {
  // Release successive dependency levels without depending on command ordering.
  for (let round = 0; round < 100; round++) {
    pending.splice(0).forEach((release) => release());
    await setImmediate();
    if (pending.length === 0) {
      return;
    }
  }
  throw new Error('Git calculations did not settle');
}

describe('WorkspaceGitStateService command scheduling', () => {
  it('overlaps independent lookups and starts dependent diffs while status is pending', async () => {
    const status = deferred<ExecResult>();
    const diffs = deferred<void>();
    const started: string[][] = [];
    let active = 0;
    let peak = 0;
    const service = new WorkspaceGitStateService({
      ...watcherOptions,
      runGit: (args) => {
        started.push(args);
        active++;
        peak = Math.max(peak, active);
        const response = args.includes('status')
          ? status.promise
          : args[0] === 'diff'
            ? diffs.promise.then(() => result(args))
            : Promise.resolve(result(args));
        return response.finally(() => {
          active--;
        });
      },
    });
    const snapshot = service.getSnapshot(input);
    try {
      await vi.waitFor(() => {
        expect(started).toContainEqual(['merge-base', 'HEAD', 'origin/main']);
        expect(started).toContainEqual([
          'rev-parse',
          '--abbrev-ref',
          '--symbolic-full-name',
          '@{upstream}',
        ]);
        expect(started.filter((args) => args[0] === 'diff').length).toBeGreaterThanOrEqual(2);
      });
    } finally {
      status.resolve(result(['status']));
      diffs.resolve();
    }
    expectSnapshot(await snapshot);
    expect(peak).toBeLessThanOrEqual(3);
    expect(started).toContainEqual(['--no-optional-locks', 'status', '--porcelain']);
    service.stop();
  });

  it('bounds commands across concurrent workspaces and preserves every snapshot', async () => {
    const pending: Array<() => void> = [];
    const activeByPath = new Map<string, number>();
    let active = 0;
    let peak = 0;
    let peakPerPath = 0;
    const service = new WorkspaceGitStateService({
      ...watcherOptions,
      runGit: (args, cwd) => {
        active++;
        activeByPath.set(cwd, (activeByPath.get(cwd) ?? 0) + 1);
        peak = Math.max(peak, active);
        peakPerPath = Math.max(peakPerPath, activeByPath.get(cwd) ?? 0);
        return new Promise((resolve) =>
          pending.push(() => {
            active--;
            activeByPath.set(cwd, (activeByPath.get(cwd) ?? 0) - 1);
            resolve(result(args));
          })
        );
      },
    });
    const snapshots = Array.from({ length: 8 }, (_, i) =>
      service.getSnapshot({ ...input, worktreePath: `/repo/w${i}` })
    );
    const mergeBases = Array.from({ length: 8 }, (_, i) =>
      service.getMergeBase({ ...input, worktreePath: `/repo/merge-base-${i}` })
    );
    try {
      await vi.waitFor(() => expect(active).toBeGreaterThan(0));
      await drainCommands(pending);
      (await Promise.all(snapshots)).forEach(expectSnapshot);
      expect(await Promise.all(mergeBases)).toEqual(Array.from({ length: 8 }, () => 'base'));
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(6);
      expect(peakPerPath).toBeLessThanOrEqual(3);
    } finally {
      for (const release of pending.splice(0)) {
        release();
      }
      service.stop();
    }
  });

  it('keeps both base errors without issuing a redundant fallback diff', async () => {
    const commands: string[][] = [];
    const service = new WorkspaceGitStateService({
      ...watcherOptions,
      runGit: (args) => {
        commands.push(args);
        if (args[1] === '--numstat' || args[1] === '--name-status') {
          return Promise.resolve({ code: 2, stdout: '', stderr: 'base diff failed' });
        }
        return Promise.resolve(result(args));
      },
    });
    const snapshot = await service.getSnapshot(input);
    expect(snapshot.base).toEqual({
      mergeBase: 'base',
      noMergeBase: false,
      stats: { total: 0, additions: 0, deletions: 0, hasUncommitted: true },
      added: [],
      modified: [],
      deleted: [],
      statsError: 'base diff failed',
      changesError: 'base diff failed',
    });
    expect(snapshot.upstream.files).toEqual(['committed.ts']);
    expect(commands.filter((args) => args[0] === 'diff')).toHaveLength(3);
    expect(commands).not.toContainEqual(['diff', '--name-only']);
    service.stop();
  });

  it('rejects immediately while bounded sibling reads settle without restoring the cache', async () => {
    const status = deferred<ExecResult>();
    const mergeBase = deferred<ExecResult>();
    const upstream = deferred<ExecResult>();
    const failure = new Error('status spawn failed');
    const commands: string[][] = [];
    const pending: Array<() => void> = [];
    let failing = true;
    let active = 0;
    let peak = 0;
    const service = new WorkspaceGitStateService({
      ...watcherOptions,
      runGit: (args) => {
        if (!failing) {
          return Promise.resolve(result(args));
        }
        commands.push(args);
        active++;
        peak = Math.max(peak, active);
        const response = args.includes('status')
          ? status.promise
          : args[0] === 'merge-base'
            ? mergeBase.promise
            : args[0] === 'rev-parse'
              ? upstream.promise
              : new Promise<ExecResult>((resolve, reject) =>
                  pending.push(() => {
                    if (args[1] === '--name-status') {
                      reject(new Error('later sibling failure'));
                    } else {
                      resolve(result(args));
                    }
                  })
                );
        return response.finally(() => {
          active--;
        });
      },
    });
    const rejected = expect(service.getSnapshot(input)).rejects.toBe(failure);
    try {
      await vi.waitFor(() => expect(commands).toHaveLength(3));
      status.reject(failure);
      await rejected;
      // Both sibling lookups are still pending when the caller receives its error.
      expect(active).toBe(2);
      expect(service.getCachedSnapshot(input)).toBeNull();
      mergeBase.resolve(result(['merge-base']));
      upstream.resolve(result(['rev-parse']));
      await setImmediate();
      expect(pending).toHaveLength(3);
      await drainCommands(pending);
      expect(active).toBe(0);
      expect(peak).toBeLessThanOrEqual(3);
      expect(service.getCachedSnapshot(input)).toBeNull();
      failing = false;
      expectSnapshot(await service.getSnapshot(input));
    } finally {
      status.reject(failure);
      await rejected;
      mergeBase.resolve(result(['merge-base']));
      upstream.resolve(result(['rev-parse']));
      await drainCommands(pending);
      service.stop();
    }
  });

  it.each(['status', 'merge-base', 'rev-parse', '--numstat', '--name-status', '--name-only'])(
    'propagates a rejected %s command and allows a fresh calculation',
    async (command) => {
      const failure = new Error('spawn failed');
      let failed = false;
      const service = new WorkspaceGitStateService({
        ...watcherOptions,
        runGit: (args) => {
          if (!failed && args.includes(command)) {
            failed = true;
            return Promise.reject(failure);
          }
          return Promise.resolve(result(args));
        },
      });
      await expect(service.getSnapshot(input)).rejects.toBe(failure);
      expect(service.getCachedSnapshot(input)).toBeNull();
      expectSnapshot(await service.getSnapshot(input));
      service.stop();
    }
  );
});
