import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '@/backend/lib/shell';
import {
  getStats,
  WorkspaceGitStateService,
  type WorkspaceGitStateSnapshot,
} from './workspace-git-state.service';

type RunGit = (args: string[], cwd: string) => Promise<ExecResult>;

function result(stdout = '', code = 0, stderr = ''): ExecResult {
  return { stdout, stderr, code };
}

function resolvedResult(stdout = '', code = 0, stderr = ''): Promise<ExecResult> {
  return Promise.resolve(result(stdout, code, stderr));
}

function defaultGitResult(args: string[]): ExecResult {
  if (args[0] === 'status') {
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
  let service: WorkspaceGitStateService;

  beforeEach(() => {
    runGit = vi.fn<RunGit>((args) => Promise.resolve(defaultGitResult(args)));
    service = new WorkspaceGitStateService({ runGit, now: () => 1234 });
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
        added: [{ path: 'new.ts', status: 'added' }],
        modified: [{ path: 'changed.ts', status: 'modified' }],
        deleted: [{ path: 'deleted.ts', status: 'deleted' }],
      },
      upstream: {
        ref: 'origin/feature',
        hasUpstream: true,
        files: ['pushed-later.ts'],
      },
    });
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
    expect(runGit.mock.calls.filter(([args]) => args[0] === 'status')).toHaveLength(1);
  });

  it('recalculates a snapshot with a transient section error', async () => {
    let statusAttempts = 0;
    runGit.mockImplementation((args) => {
      if (args[0] === 'status' && statusAttempts++ === 0) {
        return resolvedResult('', 1, 'status temporarily unavailable');
      }
      return Promise.resolve(defaultGitResult(args));
    });

    const degraded = await service.getSnapshot(input);
    const recovered = await service.getSnapshot(input);

    expect(degraded.status.error).toBe('status temporarily unavailable');
    expect(recovered.status.error).toBeUndefined();
    expect(recovered.status.files).toEqual([{ path: 'src/a.ts', status: 'M', staged: false }]);
    expect(runGit.mock.calls.filter(([args]) => args[0] === 'status')).toHaveLength(2);
  });

  it('does not cache a calculation invalidated while it is in flight', async () => {
    const first = service.getSnapshot(input);
    service.invalidate('/repo/w1');

    await first;
    await service.getSnapshot(input);

    expect(runGit.mock.calls.filter(([args]) => args[0] === 'status')).toHaveLength(2);
  });

  it('does not restore a removed entry when an old calculation completes', async () => {
    const first = service.getSnapshot(input);
    service.remove('/repo/w1');

    await first;
    await service.getSnapshot(input);

    expect(runGit.mock.calls.filter(([args]) => args[0] === 'status')).toHaveLength(2);
  });

  it('does not restore cached state after stop while a calculation is in flight', async () => {
    const first = service.getSnapshot(input);
    service.stop();

    await first;
    await service.getSnapshot(input);

    expect(runGit.mock.calls.filter(([args]) => args[0] === 'status')).toHaveLength(2);
  });

  it('keeps default branches in separate cache entries', async () => {
    const main = await service.getSnapshot(input);
    const develop = await service.getSnapshot({ ...input, defaultBranch: 'develop' });

    expect(develop).not.toBe(main);
    expect(runGit.mock.calls.filter(([args]) => args[0] === 'status')).toHaveLength(2);
  });

  it('falls back to the local default branch when the origin merge base is unavailable', async () => {
    runGit.mockImplementation((args) => {
      if (args[0] === 'status') {
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
      if (args[0] === 'status') {
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
      const command = args[0] === 'diff' ? args[1] : args[0];
      return Promise.resolve(resultsByCommand.get(command as string) ?? result());
    });

    const snapshot = await service.getSnapshot(input);

    expect(snapshot.status.error).toBe('status broke');
    expect(snapshot.base.error).toBe('base diff broke');
    expect(snapshot.upstream.error).toBe('upstream diff broke');
    expect(getStats(snapshot)).toBeNull();
  });
});
