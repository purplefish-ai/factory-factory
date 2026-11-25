import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ApplicationError } from '@/backend/lib/application-error';
import { pathExists } from '@/backend/lib/file-helpers';
import { type ExecResult, execCommand, gitCommand } from '@/backend/lib/shell';
import { configService } from '@/backend/services/config.service';

/** Paths listed in an archive snapshot's log record; the counts cover all of them. */
const MAX_LISTED_PATHS = 50;

export interface ArchivedPathSummary {
  /** Changed paths, counted from Git's output (a lower bound when `truncated`). */
  total: number;
  /** Count per `--name-status` letter, for example `{ A: 3, D: 1200 }`. */
  byStatus: Record<string, number>;
  /** The first paths, each prefixed with its status letter. */
  paths: string[];
  truncated: boolean;
}

/** Git output stays in the cause; the message reaches the client. */
function gitFailure(message: string, result: ExecResult): ApplicationError {
  return new ApplicationError('INTERNAL_ERROR', message, { cause: result });
}

/** The commit `rev` names, or null when it does not resolve (for example an unborn HEAD). */
export async function resolveCommit(cwd: string, rev: string): Promise<string | null> {
  const result = await gitCommand(['rev-parse', '--quiet', '--verify', `${rev}^{commit}`], cwd);
  if (result.code === 0) {
    return result.stdout.trim();
  }
  if (result.code === 1) {
    return null;
  }
  throw gitFailure(`Failed to resolve ${rev}`, result);
}

/** The branch HEAD is on, or null when HEAD is detached. */
export async function readHeadBranch(cwd: string): Promise<string | null> {
  const result = await gitCommand(['symbolic-ref', '--quiet', 'HEAD'], cwd);
  if (result.code === 1) {
    return null;
  }
  if (result.code !== 0) {
    throw gitFailure('Failed to read HEAD', result);
  }
  const ref = result.stdout.trim();
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
}

async function resolveIndexPath(cwd: string): Promise<string> {
  const result = await gitCommand(['rev-parse', '--git-path', 'index'], cwd);
  const indexPath = result.stdout.trim();
  if (result.code !== 0 || indexPath.length === 0) {
    throw gitFailure('Failed to locate the Git index', result);
  }
  return path.resolve(cwd, indexPath);
}

/**
 * Commit the working tree, untracked files included, through a private copy of
 * the index. No branch, HEAD or the worktree's own index moves. Copying the
 * index keeps its stat cache (so unchanged files are not rehashed), sparse
 * entries and force-added files.
 */
export async function commitWorkingTreeAside(
  cwd: string,
  parent: string | null,
  message: string
): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'ff-archive-index-'));
  try {
    const indexFile = path.join(tempDir, 'index');
    const env = { ...configService.getChildProcessEnv(), GIT_INDEX_FILE: indexFile };
    const git = async (args: string[], failure: string): Promise<string> => {
      const result = await execCommand('git', args, { cwd, env });
      if (result.code !== 0) {
        throw gitFailure(failure, result);
      }
      return result.stdout.trim();
    };

    const worktreeIndex = await resolveIndexPath(cwd);
    if (await pathExists(worktreeIndex)) {
      await fs.copyFile(worktreeIndex, indexFile);
    } else {
      await git(['read-tree', ...(parent ? [parent] : ['--empty'])], 'Git read-tree failed');
    }
    await git(['add', '-A'], 'Git add failed');
    const tree = await git(['write-tree'], 'Git write-tree failed');
    return await git(
      ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message],
      'Git commit-tree failed'
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/** What a snapshot commit changed relative to its parent. Best effort: null when Git fails. */
export async function summarizeSnapshotPaths(
  cwd: string,
  sha: string
): Promise<ArchivedPathSummary | null> {
  const result = await gitCommand(
    ['diff-tree', '-r', '--root', '--no-commit-id', '--name-status', '--no-renames', sha],
    cwd
  );
  if (result.code !== 0) {
    return null;
  }
  const summary: ArchivedPathSummary = {
    total: 0,
    byStatus: {},
    paths: [],
    truncated: result.stdoutOverflowed === true,
  };
  for (const line of result.stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) {
      continue;
    }
    const status = line.slice(0, tab);
    summary.total += 1;
    summary.byStatus[status] = (summary.byStatus[status] ?? 0) + 1;
    if (summary.paths.length < MAX_LISTED_PATHS) {
      summary.paths.push(`${status} ${line.slice(tab + 1)}`);
    }
  }
  return summary;
}
