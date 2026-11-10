import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ExecResult, gitCommand } from '@/backend/lib/shell';
import { WorkspaceGitStateService } from './workspace-git-state.service';

type RunGit = (args: string[], cwd: string) => Promise<ExecResult>;
type WatchListener = (eventType: string, filename: string | null) => void;

function result(stdout = '', code = 0, stderr = ''): ExecResult {
  return { stdout, stderr, code };
}

const NO_UPSTREAM = result('', 128, "fatal: no upstream configured for branch 'feature-1'");
const GONE_UPSTREAM = result(
  '@{upstream}\n',
  128,
  "fatal: ambiguous argument '@{upstream}': unknown revision or path not in the working tree."
);

const w1 = { worktreePath: '/repo/w1', defaultBranch: 'main' };
const w2 = { worktreePath: '/repo/w2', defaultBranch: 'main' };

describe('WorkspaceGitStateService shared ref invalidation', () => {
  let files: Map<string, string>;
  let upstreams: Map<string, ExecResult>;
  let originMergeBase: ExecResult;
  let runGit: ReturnType<typeof vi.fn<RunGit>>;
  let sharedListener: WatchListener | undefined;
  let service: WorkspaceGitStateService;

  beforeEach(() => {
    vi.useFakeTimers();
    files = new Map([
      ['/repo/w1/.git', 'gitdir: /repo/.git/worktrees/w1\n'],
      ['/repo/w2/.git', 'gitdir: /repo/.git/worktrees/w2\n'],
      ['/repo/.git/worktrees/w1/commondir', '../..\n'],
      ['/repo/.git/worktrees/w2/commondir', '../..\n'],
      ['/repo/.git/worktrees/w1/HEAD', 'ref: refs/heads/feature-1\n'],
      ['/repo/.git/worktrees/w2/HEAD', 'ref: refs/heads/feature-2\n'],
      ['/repo/.git/refs/heads/feature-1', `${'1'.repeat(40)}\n`],
    ]);
    upstreams = new Map([
      ['/repo/w1', result('origin/feature-1\n')],
      ['/repo/w2', result('origin/feature-2\n')],
    ]);
    originMergeBase = result('abc123\n');
    runGit = vi.fn<RunGit>((args, cwd) => {
      if (args[0] === 'merge-base') {
        return Promise.resolve(args[2] === 'origin/main' ? originMergeBase : result('def456\n'));
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve(upstreams.get(cwd) ?? NO_UPSTREAM);
      }
      return Promise.resolve(result());
    });
    sharedListener = undefined;
    service = new WorkspaceGitStateService({
      runGit,
      readFile: (filePath) => {
        const contents = files.get(filePath);
        if (contents !== undefined) {
          return Promise.resolve(contents);
        }
        if (filePath === '/repo/.git') {
          return Promise.reject(Object.assign(new Error('directory'), { code: 'EISDIR' }));
        }
        return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      },
      watchPath: (filePath, _options, listener) => {
        if (filePath === '/repo/.git') {
          sharedListener = listener;
        }
        return {
          close: () => undefined,
          on() {
            return this;
          },
        };
      },
      platform: 'darwin',
    });
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  async function warm() {
    return [await service.getSnapshot(w1), await service.getSnapshot(w2)] as const;
  }

  async function emitShared(...filenames: Array<string | null>) {
    for (const filename of filenames) {
      sharedListener?.('change', filename);
    }
    await vi.advanceTimersByTimeAsync(100);
  }

  async function freshness() {
    const [first, second] = await warm();
    return async () => ({
      w1: (await service.getSnapshot(w1)) === first ? 'warm' : 'recomputed',
      w2: (await service.getSnapshot(w2)) === second ? 'warm' : 'recomputed',
    });
  }

  it.each([
    ['a commit to its branch', 'refs/heads/feature-2'],
    ['a locked write to its branch', 'refs/heads/feature-2.lock'],
    ['a case-folded write to its branch', 'refs/heads/Feature-2'],
    ['a push to its upstream', 'refs/remotes/origin/feature-2'],
    ['a ref that would make its upstream name ambiguous', 'refs/heads/origin/feature-2'],
  ])('invalidates only the worktree that reads %s', async (_label, filename) => {
    const check = await freshness();

    await emitShared(filename);

    expect(await check()).toEqual({ w1: 'warm', w2: 'recomputed' });
  });

  it('scopes the events macOS reports for a commit in another worktree', async () => {
    const check = await freshness();

    // Observed with Git 2.56: the packed-refs lock is taken and released, but
    // packed-refs itself is not rewritten.
    await emitShared('refs/heads/feature-2.lock', 'refs/heads/feature-2', 'packed-refs.lock');

    expect(await check()).toEqual({ w1: 'warm', w2: 'recomputed' });
  });

  it.each([
    ['the base remote-tracking branch', 'refs/remotes/origin/main'],
    ['a packed-refs rewrite', 'packed-refs.new'],
    ['a tag shadowing the base', 'refs/tags/origin/main'],
    ['a ref directory', 'refs/heads'],
    ['packed refs', 'packed-refs'],
    ['an unnamed event', null],
    ['replace refs', 'refs/replace/abc'],
    ['reftable storage', 'reftable/tables.list'],
    ['shared config', 'config'],
  ])('invalidates every worktree after %s changes', async (_label, filename) => {
    const check = await freshness();

    await emitShared(filename);

    expect(await check()).toEqual({ w1: 'recomputed', w2: 'recomputed' });
  });

  it('keeps every worktree warm when an unrelated branch or tag changes', async () => {
    const check = await freshness();

    await emitShared('refs/heads/feature-3', 'refs/remotes/origin/feature-3', 'refs/tags/v1.0.0');

    expect(await check()).toEqual({ w1: 'warm', w2: 'warm' });
    expect(runGit.mock.calls.filter(([args]) => args.includes('status'))).toHaveLength(2);
  });

  it('invalidates on the local default branch only when the snapshot fell back to it', async () => {
    const check = await freshness();
    await emitShared('refs/heads/main');
    expect(await check()).toEqual({ w1: 'warm', w2: 'warm' });

    originMergeBase = result('', 1);
    service.invalidateAll();
    const fallback = await freshness();
    await emitShared('refs/heads/main');
    expect(await fallback()).toEqual({ w1: 'recomputed', w2: 'recomputed' });
  });

  it('accumulates every ref changed within one debounce window', async () => {
    const check = await freshness();

    sharedListener?.('change', 'refs/heads/feature-1');
    await vi.advanceTimersByTimeAsync(50);
    await emitShared('refs/heads/feature-3');

    expect(await check()).toEqual({ w1: 'recomputed', w2: 'warm' });
  });

  it('keeps a snapshot without an upstream warm only when no ref can create one', async () => {
    upstreams.set('/repo/w1', NO_UPSTREAM);
    upstreams.set('/repo/w2', GONE_UPSTREAM);
    const check = await freshness();

    await emitShared('refs/remotes/origin/feature-3');

    expect(await check()).toEqual({ w1: 'warm', w2: 'recomputed' });
  });

  it('treats every ref change as relevant when HEAD cannot be read', async () => {
    files.delete('/repo/.git/worktrees/w2/HEAD');
    const check = await freshness();

    await emitShared('refs/heads/feature-3');

    expect(await check()).toEqual({ w1: 'warm', w2: 'recomputed' });
  });

  it('keeps a detached worktree warm when other branches change', async () => {
    files.set('/repo/.git/worktrees/w2/HEAD', `${'2'.repeat(40)}\n`);
    upstreams.set('/repo/w2', result('', 128, 'fatal: HEAD does not point to a branch'));
    const check = await freshness();

    await emitShared('refs/heads/feature-2');

    expect(await check()).toEqual({ w1: 'warm', w2: 'warm' });
  });

  it('treats every ref change as relevant when a dependency is a loose symbolic ref', async () => {
    files.set('/repo/.git/refs/heads/feature-2', 'ref: refs/heads/feature-2-target\n');
    const check = await freshness();

    await emitShared('refs/heads/feature-2-target');

    expect(await check()).toEqual({ w1: 'warm', w2: 'recomputed' });
  });

  it('fences a calculation still running when any shared ref changes', async () => {
    await service.getSnapshot(w1);
    let releaseCommand!: () => void;
    const commandHeld = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    runGit.mockImplementationOnce(async () => {
      await commandHeld;
      return result();
    });
    const running = service.getSnapshot(w2);
    await vi.advanceTimersByTimeAsync(0);

    await emitShared('refs/heads/feature-3');
    releaseCommand();
    const stale = await running;

    expect(await service.getSnapshot(w2)).not.toBe(stale);
  });
});

describe('WorkspaceGitStateService shared ref dependencies with real Git', () => {
  it('reads branch, upstream and base refs from linked worktrees', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ff-shared-refs-')));
    const git = async (cwd: string, ...args: string[]) => {
      const outcome = await gitCommand(
        ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
        cwd
      );
      expect(outcome.code, outcome.stderr).toBe(0);
    };
    const listeners: WatchListener[] = [];
    const service = new WorkspaceGitStateService({
      platform: 'darwin',
      watchPath: (filePath, _options, listener) => {
        if (filePath === path.join(root, 'clone/.git')) {
          listeners.push(listener);
        }
        return {
          close: () => undefined,
          on() {
            return this;
          },
        };
      },
    });
    try {
      await git(root, 'init', '-q', '-b', 'main', 'origin');
      await git(path.join(root, 'origin'), 'commit', '-q', '--allow-empty', '-m', 'Initial');
      await git(root, 'clone', '-q', 'origin', 'clone');
      const clone = path.join(root, 'clone');
      // One worktree tracks origin/main, as workspace creation does; the other
      // has no upstream configured.
      await git(clone, 'worktree', 'add', '-q', '-b', 'tracked', '../tracked', 'origin/main');
      await git(clone, 'worktree', 'add', '-q', '--no-track', '-b', 'loose', '../loose', 'main');
      const tracked = { worktreePath: path.join(root, 'tracked'), defaultBranch: 'main' };
      const loose = { worktreePath: path.join(root, 'loose'), defaultBranch: 'main' };
      const warm = async () =>
        [await service.getSnapshot(tracked), await service.getSnapshot(loose)] as const;
      const emit = async (filename: string) => {
        for (const listener of listeners) {
          listener('change', filename);
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      };

      let [first, second] = await warm();
      expect(first.upstream.ref).toBe('origin/main');
      expect(second.upstream.ref).toBeNull();
      expect(listeners).toHaveLength(1);

      await emit('refs/heads/loose');
      expect(service.getCachedSnapshot(tracked)).toBe(first);
      expect(service.getCachedSnapshot(loose)).toBeNull();

      [first, second] = await warm();
      await emit('refs/remotes/origin/feature');
      expect(service.getCachedSnapshot(tracked)).toBe(first);
      expect(service.getCachedSnapshot(loose)).toBe(second);

      await emit('refs/remotes/origin/main');
      expect(service.getCachedSnapshot(tracked)).toBeNull();
      expect(service.getCachedSnapshot(loose)).toBeNull();
    } finally {
      service.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
