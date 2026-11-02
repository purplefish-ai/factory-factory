import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '@/backend/lib/shell';
import { WorkspaceGitStateService } from './workspace-git-state.service';

const input = { worktreePath: '/repo/worktree', defaultBranch: 'main' };

function createHarness() {
  const releases: Array<(result: ExecResult) => void> = [];
  const runGit = vi.fn((args: string[]) => {
    if (args.includes('status')) {
      return new Promise<ExecResult>((resolve) => releases.push(resolve));
    }
    return Promise.resolve({
      code: 0,
      stderr: '',
      stdout: args[0] === 'merge-base' ? 'base\n' : args[0] === 'rev-parse' ? 'origin/main\n' : '',
    });
  });
  const service = new WorkspaceGitStateService({
    runGit,
    readFile: () => Promise.reject(Object.assign(new Error('directory'), { code: 'EISDIR' })),
    watchPath: () => ({
      close() {
        // No real filesystem watcher is needed for explicit invalidation tests.
      },
      on() {
        return this;
      },
    }),
  });
  return { service, runGit, releases };
}

const cleanStatus = { code: 0, stderr: '', stdout: '' };

describe('workspace Git invalidation singleflight', () => {
  it('coalesces a burst into one sequential refresh with current data for waiting readers', async () => {
    const { service, releases } = createHarness();
    const first = service.getSnapshot(input);
    await setImmediate();
    const readers = [];
    for (let index = 0; index < 20; index++) {
      service.invalidate(input.worktreePath);
      readers.push(service.getSnapshot(input));
      await setImmediate();
    }
    expect(releases).toHaveLength(1);
    expect(service.getCachedSnapshot(input)).toBeNull();

    releases[0]?.({ ...cleanStatus, stdout: ' M stale.txt\n' });
    const stale = await first;
    await setImmediate();
    expect(releases).toHaveLength(2);
    expect(service.getCachedSnapshot(input)).toBeNull();
    releases[1]?.({ ...cleanStatus, stdout: ' M current.txt\n' });
    const snapshots = await Promise.all(readers);
    expect(stale.status.files[0]?.path).toBe('stale.txt');
    expect(snapshots.every((snapshot) => snapshot === snapshots[0])).toBe(true);
    expect(snapshots[0]?.status.files[0]?.path).toBe('current.txt');
    expect(service.getCachedSnapshot(input)).toBe(snapshots[0]);
    expect(service.getGenerationCount()).toBe(0);
    service.stop();
  });

  it.each(['remove', 'stop'] as const)(
    'does not launch a queued refresh after %s',
    async (operation) => {
      const { service, releases } = createHarness();
      const first = service.getSnapshot(input);
      await setImmediate();
      service.invalidate(input.worktreePath);
      const waiting = service.getSnapshot(input);
      if (operation === 'remove') {
        service.remove(input.worktreePath);
      } else {
        service.stop();
      }
      releases[0]?.(cleanStatus);
      await Promise.all([first, waiting]);
      expect(releases).toHaveLength(1);
      expect(service.getCachedSnapshot(input)).toBeNull();
      expect(service.getGenerationCount()).toBe(0);
    }
  );

  it('runs a later generation after invalidation during the follow-up without publishing stale data', async () => {
    const { service, releases } = createHarness();
    const first = service.getSnapshot(input);
    await setImmediate();
    service.invalidate(input.worktreePath);
    const second = service.getSnapshot(input);
    releases[0]?.(cleanStatus);
    await first;
    await setImmediate();
    service.invalidate(input.worktreePath);
    const third = service.getSnapshot(input);
    expect(releases).toHaveLength(2);
    releases[1]?.(cleanStatus);
    await second;
    await setImmediate();
    expect(service.getCachedSnapshot(input)).toBeNull();
    expect(releases).toHaveLength(3);
    releases[2]?.(cleanStatus);
    expect(service.getCachedSnapshot(input)).toBeNull();
    expect(await third).toBe(service.getCachedSnapshot(input));
    service.stop();
  });
  it.each(['status', 'numstat'])(
    'keeps ownership until sibling commands drain after a rejected %s command',
    async (failure) => {
      const { service, runGit, releases } = createHarness();
      const execute = runGit.getMockImplementation();
      let releaseSibling: ((value: ExecResult) => void) | undefined;
      let failed = false;
      let initialStatus = true;
      const isFailureCommand =
        failure === 'status'
          ? (args: string[]) => args.includes('status')
          : (args: string[]) => args.includes('--numstat');
      const isSiblingCommand =
        failure === 'status'
          ? (args: string[]) => args[0] === 'merge-base'
          : (args: string[]) => args.includes('--name-status');
      runGit.mockImplementation((args) => {
        if (failure === 'numstat' && args.includes('status') && initialStatus) {
          initialStatus = false;
          return Promise.resolve(cleanStatus);
        }
        if (!failed && isFailureCommand(args)) {
          failed = true;
          return Promise.reject(new Error('spawn failed'));
        }
        if (!releaseSibling && isSiblingCommand(args)) {
          return new Promise((resolve) => {
            releaseSibling = resolve;
          });
        }
        return execute!(args);
      });
      let settled = false;
      const first = service.getSnapshot(input).catch((error: unknown) => {
        settled = true;
        return error;
      });
      await setImmediate();
      service.invalidate(input.worktreePath);
      const second = service.getSnapshot(input);
      await setImmediate();
      expect(settled).toBe(false);
      expect(releases).toHaveLength(0);
      releaseSibling?.({ ...cleanStatus, stdout: failure === 'status' ? 'base\n' : '' });
      expect(await first).toEqual(new Error('spawn failed'));
      await setImmediate();
      expect(releases).toHaveLength(1);
      releases[0]?.(cleanStatus);
      expect(await second).toBe(service.getCachedSnapshot(input));
      expect(service.getGenerationCount()).toBe(0);
      service.stop();
    }
  );

  it('refreshes for a new watcher lifecycle without reviving an earlier queued read', async () => {
    const { service, releases } = createHarness();
    const first = service.getSnapshot(input);
    await setImmediate();
    service.invalidate(input.worktreePath);
    const retired = service.getSnapshot(input);
    service.remove(input.worktreePath);
    const current = service.getSnapshot(input);
    expect(releases).toHaveLength(1);
    releases[0]?.({ ...cleanStatus, stdout: ' M retired.txt\n' });
    expect(await retired).toBe(await first);
    await setImmediate();
    expect(releases).toHaveLength(2);
    releases[1]?.({ ...cleanStatus, stdout: ' M current.txt\n' });
    expect((await current).status.files[0]?.path).toBe('current.txt');
    expect(service.getCachedSnapshot(input)).toBe(await current);
    service.stop();
  });
});
