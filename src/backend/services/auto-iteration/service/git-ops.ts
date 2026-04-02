import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function git(worktreePath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 });
}

/** Stage all changes and commit with a message. Returns the short commit SHA. */
export async function commitAll(worktreePath: string, message: string): Promise<string> {
  await git(worktreePath, ['add', '-A']);
  await git(worktreePath, ['commit', '-m', message, '--allow-empty']);
  const { stdout } = await git(worktreePath, ['rev-parse', '--short', 'HEAD']);
  return stdout.trim();
}

/** Revert the most recent commit. */
export async function revertHead(worktreePath: string): Promise<void> {
  await git(worktreePath, ['revert', 'HEAD', '--no-edit']);
}

/** Get the diff of the most recent commit. */
export async function getHeadDiff(worktreePath: string): Promise<string> {
  const { stdout } = await git(worktreePath, ['diff', 'HEAD~1..HEAD']);
  return stdout;
}

/** Check if there are any uncommitted changes. */
export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const { stdout } = await git(worktreePath, ['status', '--porcelain']);
  return stdout.trim().length > 0;
}
