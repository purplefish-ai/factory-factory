import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.hoisted(() => vi.fn());
const mockGitStateInvalidate = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

vi.mock('@/backend/services/workspace-git-state.service', () => ({
  workspaceGitStateService: { invalidate: mockGitStateInvalidate },
}));

import { amendHead, commitAll, discardUncommittedChanges, revertHead } from './git-ops';

type ExecCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

function succeedGit(stdout = ''): void {
  mockExecFile.mockImplementation(
    (_file: string, _args: string[], _options: object, callback: ExecCallback) => {
      callback(null, { stdout, stderr: '' });
    }
  );
}

describe('auto-iteration Git mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    succeedGit('abc123\n');
  });

  it.each([
    ['commit', () => commitAll('/repo/w1', 'iteration')],
    ['amend', () => amendHead('/repo/w1')],
    ['revert', () => revertHead('/repo/w1')],
    ['discard', () => discardUncommittedChanges('/repo/w1')],
  ])('invalidates after a successful %s mutation', async (_name, mutate) => {
    await mutate();

    expect(mockGitStateInvalidate).toHaveBeenCalledOnce();
    expect(mockGitStateInvalidate).toHaveBeenCalledWith('/repo/w1');
  });

  it('does not invalidate when an auto-iteration mutation fails', async () => {
    mockExecFile.mockImplementation(
      (_file: string, _args: string[], _options: object, callback: ExecCallback) => {
        callback(new Error('git failed'));
      }
    );

    await expect(revertHead('/repo/w1')).rejects.toThrow('git failed');

    expect(mockGitStateInvalidate).not.toHaveBeenCalled();
  });
});
