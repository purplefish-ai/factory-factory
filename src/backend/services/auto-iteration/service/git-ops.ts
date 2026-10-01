import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workspaceGitStateService } from '@/backend/services/workspace-git-state.service';

const execFileAsync = promisify(execFile);
const IMPLEMENTATION_PATHS = ['.', ':(top,exclude).factory-factory'];

function git(worktreePath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 });
}

/** Commit implementation changes, excluding runtime files. Returns the short commit SHA. */
export async function commitAll(worktreePath: string, message: string): Promise<string> {
  try {
    await git(worktreePath, ['add', '-A', '--', ...IMPLEMENTATION_PATHS]);
    await unstageRuntimeDirectory(worktreePath);
    await git(worktreePath, ['commit', '-m', message, '--allow-empty']);
  } finally {
    workspaceGitStateService.invalidate(worktreePath);
  }
  const { stdout } = await git(worktreePath, ['rev-parse', '--short', 'HEAD']);
  return stdout.trim();
}

/** Amend the most recent commit with staged changes. Returns the updated short commit SHA. */
export async function amendHead(worktreePath: string): Promise<string> {
  try {
    await git(worktreePath, ['add', '-A', '--', ...IMPLEMENTATION_PATHS]);
    await unstageRuntimeDirectory(worktreePath);
    await git(worktreePath, ['commit', '--amend', '--no-edit']);
  } finally {
    workspaceGitStateService.invalidate(worktreePath);
  }
  const { stdout } = await git(worktreePath, ['rev-parse', '--short', 'HEAD']);
  return stdout.trim();
}

/** Revert the most recent commit. */
export async function revertHead(worktreePath: string): Promise<void> {
  try {
    await git(worktreePath, ['revert', 'HEAD', '--no-edit']);
  } finally {
    workspaceGitStateService.invalidate(worktreePath);
  }
}

/** Get the diff of the most recent commit. Works on root commits too. */
export async function getHeadDiff(worktreePath: string): Promise<string> {
  const { stdout } = await git(worktreePath, ['show', '--format=', 'HEAD']);
  return stdout;
}

/** Discard all uncommitted changes (staged and unstaged). */
export async function discardUncommittedChanges(worktreePath: string): Promise<void> {
  try {
    const headExists = await hasHead(worktreePath);
    await unstageRuntimeDirectory(worktreePath);
    if (headExists) {
      await git(worktreePath, ['reset', '--hard', 'HEAD']);
    } else {
      await git(worktreePath, ['rm', '-r', '--force', '--cached', '--ignore-unmatch', '--', '.']);
    }
    await git(worktreePath, ['clean', '-fd', '-e', '/.factory-factory/']);
  } finally {
    workspaceGitStateService.invalidate(worktreePath);
  }
}

/** Check for implementation changes outside the root runtime directory. */
export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const { stdout } = await git(worktreePath, [
    'status',
    '--porcelain',
    '--',
    ...IMPLEMENTATION_PATHS,
  ]);
  return stdout.trim().length > 0;
}

async function hasHead(worktreePath: string): Promise<boolean> {
  try {
    await git(worktreePath, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
      return false;
    }
    throw error;
  }
}

async function unstageRuntimeDirectory(worktreePath: string): Promise<void> {
  try {
    await git(worktreePath, ['reset', 'HEAD', '--', '.factory-factory/']);
  } catch {
    await git(worktreePath, [
      'rm',
      '-r',
      '--force',
      '--cached',
      '--ignore-unmatch',
      '--',
      '.factory-factory/',
    ]);
  }
}
