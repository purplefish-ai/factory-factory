/**
 * Git Helper Functions
 *
 * This module provides git-related utility functions for parsing git output
 * and computing workspace statistics.
 */

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
 * Parse git diff --numstat output to get file, addition, and deletion totals.
 */
export function parseNumstatOutput(output: string): {
  total: number;
  additions: number;
  deletions: number;
} {
  let total = 0;
  let additions = 0;
  let deletions = 0;

  if (!output.trim()) {
    return { total, additions, deletions };
  }

  for (const line of output.trim().split('\n')) {
    total += 1;
    const [add, del] = line.split('\t');
    // Binary files show as '-' for add/del
    if (add !== '-') {
      additions += Number.parseInt(add as string, 10) || 0;
    }
    if (del !== '-') {
      deletions += Number.parseInt(del as string, 10) || 0;
    }
  }

  return { total, additions, deletions };
}
