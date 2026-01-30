/**
 * Git Helper Functions
 *
 * This module provides git-related utility functions for parsing git output
 * and computing workspace statistics.
 */

import { gitCommand } from './shell';

// =============================================================================
// Types
// =============================================================================

export type GitFileStatus = 'M' | 'A' | 'D' | '?';

export interface GitStatusFile {
  path: string;
  status: GitFileStatus;
  staged: boolean;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Parse git status --porcelain output into structured data.
 * Exported for testing.
 */
export function parseGitStatusOutput(output: string): GitStatusFile[] {
  // Split by newlines and filter empty lines. Don't use trim() on the whole output
  // as that removes the leading space which is part of the git status format
  // (a leading space in position 0 indicates the file is not staged).
  const lines = output.split('\n').filter((line) => line.length > 0);
  const files: GitStatusFile[] = [];

  for (const line of lines) {
    if (line.length < 4) {
      continue;
    }

    // Format: XY filename
    // X = staged status, Y = unstaged status
    const stagedStatus = line[0];
    const unstagedStatus = line[1];
    const filePath = line.slice(3);

    // Determine if file is staged (has a non-space/non-? in first column)
    const staged = stagedStatus !== ' ' && stagedStatus !== '?';

    // Determine the status to show
    let status: GitFileStatus;
    if (stagedStatus === '?' || unstagedStatus === '?') {
      status = '?';
    } else if (stagedStatus === 'A' || unstagedStatus === 'A') {
      status = 'A';
    } else if (stagedStatus === 'D' || unstagedStatus === 'D') {
      status = 'D';
    } else {
      status = 'M';
    }

    files.push({ path: filePath, status, staged });
  }

  return files;
}

/**
 * Parse git diff --numstat output to get total additions and deletions.
 */
export function parseNumstatOutput(output: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  if (!output.trim()) {
    return { additions, deletions };
  }

  for (const line of output.trim().split('\n')) {
    const [add, del] = line.split('\t');
    // Binary files show as '-' for add/del
    if (add !== '-') {
      additions += Number.parseInt(add, 10) || 0;
    }
    if (del !== '-') {
      deletions += Number.parseInt(del, 10) || 0;
    }
  }

  return { additions, deletions };
}

/**
 * Get the merge base between HEAD and the default branch.
 * Tries local branch first, falls back to origin/.
 * Returns null if no merge base can be found.
 */
export async function getMergeBase(
  worktreePath: string,
  defaultBranch: string
): Promise<string | null> {
  const candidates = [defaultBranch, `origin/${defaultBranch}`];

  for (const base of candidates) {
    const result = await gitCommand(['merge-base', 'HEAD', base], worktreePath);
    if (result.code === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  }
  return null;
}

/**
 * Fetch git stats (additions/deletions/file count) for a single workspace.
 * Returns null if the workspace has no worktree or git commands fail.
 */
export async function getWorkspaceGitStats(
  worktreePath: string,
  defaultBranch: string
): Promise<{
  total: number;
  additions: number;
  deletions: number;
  hasUncommitted: boolean;
} | null> {
  // Check for uncommitted changes
  const statusResult = await gitCommand(['status', '--porcelain'], worktreePath);
  if (statusResult.code !== 0) {
    return null;
  }
  const hasUncommitted = statusResult.stdout.trim().length > 0;

  // Get merge base with the project's default branch
  const mergeBase = await getMergeBase(worktreePath, defaultBranch);

  // Get all changes from merge base (committed + uncommitted)
  const diffArgs = mergeBase ? ['diff', '--numstat', mergeBase] : ['diff', '--numstat'];
  const diffResult = await gitCommand(diffArgs, worktreePath);

  // Get file count from main-relative diff
  const fileCountArgs = mergeBase ? ['diff', '--name-only', mergeBase] : ['diff', '--name-only'];
  const fileCountResult = await gitCommand(fileCountArgs, worktreePath);
  const total =
    fileCountResult.code === 0
      ? fileCountResult.stdout
          .trim()
          .split('\n')
          .filter((l) => l.length > 0).length
      : 0;

  const { additions, deletions } =
    diffResult.code === 0 ? parseNumstatOutput(diffResult.stdout) : { additions: 0, deletions: 0 };

  return { total, additions, deletions, hasUncommitted };
}
