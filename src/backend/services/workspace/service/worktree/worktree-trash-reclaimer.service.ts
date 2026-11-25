import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { toError } from '@/backend/lib/error-utils';
import { SERVICE_INTERVAL_MS } from '@/backend/services/constants';
import { type JobRunner, jobRunner } from '@/backend/services/job-runner.service';
import { createLogger } from '@/backend/services/logger.service';
import { projectAccessor } from '@/backend/services/workspace/resources/project.accessor';
import { deleteTrashEntry, findTrashDir, isTrashEntryName } from './worktree-trash';

const JOB = 'worktree-trash-reclaim';
const logger = createLogger(JOB);

export interface WorktreeTrashReclaimerDependencies {
  listWorktreeBasePaths(): Promise<string[]>;
}

/**
 * Deletes the worktrees that removal moved into each project's trash
 * (`worktree-trash.ts`), one entry at a time and with no deadline. Runs at
 * start, whenever a worktree is moved, and periodically as a fallback. A stop
 * ends the deletion in flight; the next run resumes the partly deleted entry.
 */
export class WorktreeTrashReclaimer {
  private started = false;

  constructor(
    private readonly dependencies: WorktreeTrashReclaimerDependencies = {
      listWorktreeBasePaths: () => projectAccessor.listWorktreeBasePaths(),
    },
    private readonly runner: JobRunner = jobRunner
  ) {
    runner.register({
      name: JOB,
      intervalMs: SERVICE_INTERVAL_MS.worktreeTrashReclaim,
      runImmediately: true,
      run: (signal) => this.run(signal),
    });
  }

  start(): void {
    this.started = true;
    this.runner.start(JOB);
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.runner.stop(JOB);
  }

  /** Reclaim soon: something was just moved to a trash. A no-op until started. */
  wake(): void {
    if (this.started) {
      this.runner.wake(JOB);
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    const trashDirs = new Set<string>();
    for (const basePath of new Set(await this.dependencies.listWorktreeBasePaths())) {
      if (!basePath) {
        continue;
      }
      try {
        const trashDir = await findTrashDir(basePath);
        if (trashDir) {
          trashDirs.add(trashDir);
        }
      } catch (error) {
        logger.warn('Skipping worktree trash that failed its safety checks', {
          worktreeBasePath: basePath,
          error: toError(error).message,
        });
      }
    }
    for (const trashDir of trashDirs) {
      if (signal.aborted) {
        return;
      }
      await this.reclaimTrashDir(trashDir, signal);
    }
  }

  private async reclaimTrashDir(trashDir: string, signal: AbortSignal): Promise<void> {
    let names: string[];
    try {
      names = await readdir(trashDir);
    } catch (error) {
      logger.warn('Cannot read worktree trash', { trashDir, error: toError(error).message });
      return;
    }
    for (const name of names) {
      if (signal.aborted) {
        return;
      }
      if (!isTrashEntryName(name)) {
        continue;
      }
      const entryPath = path.join(trashDir, name);
      const startedAt = Date.now();
      try {
        await deleteTrashEntry(entryPath, signal);
        if (!signal.aborted) {
          logger.info('Reclaimed worktree from trash', {
            entryPath,
            durationMs: Date.now() - startedAt,
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        logger.warn('Failed to reclaim worktree from trash; the next run retries', {
          entryPath,
          error: toError(error).message,
        });
      }
    }
  }
}

export const worktreeTrashReclaimer = new WorktreeTrashReclaimer();
