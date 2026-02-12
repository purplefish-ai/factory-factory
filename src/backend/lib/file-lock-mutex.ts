import * as fs from 'node:fs/promises';
import { createLogger } from '@/backend/services/logger.service';

const logger = createLogger('file-lock-mutex');

const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 50;
const DEFAULT_LOCK_MAX_RETRY_DELAY_MS = 500;
const DEFAULT_LOCK_MAX_STALE_RETRIES = 3;

export interface FileLockMutexOptions {
  acquireTimeoutMs: number;
  postTimeoutWaitMs: number;
  initialRetryDelayMs: number;
  maxRetryDelayMs: number;
  maxStaleRetries: number;
  staleThresholdMs: number;
}

export class FileLockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileLockTimeoutError';
  }
}

export class FileLockMutex {
  private options: FileLockMutexOptions;

  constructor(options: Partial<FileLockMutexOptions> = {}) {
    const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS;

    this.options = {
      acquireTimeoutMs,
      postTimeoutWaitMs: options.postTimeoutWaitMs ?? 0,
      initialRetryDelayMs: options.initialRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS,
      maxRetryDelayMs: options.maxRetryDelayMs ?? DEFAULT_LOCK_MAX_RETRY_DELAY_MS,
      maxStaleRetries: options.maxStaleRetries ?? DEFAULT_LOCK_MAX_STALE_RETRIES,
      staleThresholdMs: options.staleThresholdMs ?? acquireTimeoutMs * 5,
    };
  }

  async acquire(lockPath: string): Promise<() => Promise<void>> {
    const startTime = Date.now();
    let retryDelay = this.options.initialRetryDelayMs;
    let staleRetryCount = 0;

    while (true) {
      try {
        const fileHandle = await fs.open(lockPath, 'wx');
        return this.createLockCleanup(fileHandle, lockPath);
      } catch (error) {
        const resolution = await this.resolveAcquireContention({
          error,
          lockPath,
          startTime,
          staleRetryCount,
        });
        staleRetryCount = resolution.staleRetryCount;

        if (resolution.continueImmediately) {
          continue;
        }

        await this.sleep(retryDelay);
        retryDelay = Math.min(retryDelay * 2, this.options.maxRetryDelayMs);
      }
    }
  }

  private async resolveAcquireContention({
    error,
    lockPath,
    startTime,
    staleRetryCount,
  }: {
    error: unknown;
    lockPath: string;
    startTime: number;
    staleRetryCount: number;
  }): Promise<{ staleRetryCount: number; continueImmediately: boolean }> {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'EEXIST') {
      throw error;
    }

    const elapsed = Date.now() - startTime;
    const hardTimeoutMs = this.options.acquireTimeoutMs + this.options.postTimeoutWaitMs;

    if (elapsed < this.options.acquireTimeoutMs) {
      return { staleRetryCount, continueImmediately: false };
    }

    const staleResolution = await this.tryHandleStaleLockAfterTimeout(lockPath, staleRetryCount);
    if (staleResolution.staleRemoved) {
      return {
        staleRetryCount: staleResolution.newCount,
        continueImmediately: true,
      };
    }

    const elapsedAfterStaleCheck = Date.now() - startTime;
    if (elapsedAfterStaleCheck >= hardTimeoutMs) {
      throw new FileLockTimeoutError(
        `Failed to acquire lock after ${hardTimeoutMs}ms and ${staleResolution.newCount} stale removal attempts: ${lockPath}`
      );
    }

    return {
      staleRetryCount: staleResolution.newCount,
      continueImmediately: false,
    };
  }

  private createLockCleanup(fileHandle: fs.FileHandle, lockPath: string): () => Promise<void> {
    let released = false;

    return async () => {
      if (released) {
        return;
      }
      released = true;

      const handleIno = await this.getInodeAndClose(fileHandle, lockPath);
      if (handleIno === undefined) {
        return;
      }

      await this.unlinkIfOwned(lockPath, handleIno);
    };
  }

  private async getInodeAndClose(
    fileHandle: fs.FileHandle,
    lockPath: string
  ): Promise<number | undefined> {
    let handleIno: number | undefined;

    try {
      const handleStat = await fileHandle.stat();
      handleIno = handleStat.ino;
    } catch (error) {
      logger.warn('Failed to stat file handle during cleanup', {
        lockPath,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await fileHandle.close().catch((closeError) => {
        logger.warn('Failed to close file handle during cleanup', {
          lockPath,
          error: closeError instanceof Error ? closeError.message : String(closeError),
        });
      });
    }

    return handleIno;
  }

  private async unlinkIfOwned(lockPath: string, expectedIno: number): Promise<void> {
    try {
      const pathStat = await fs.stat(lockPath);
      if (pathStat.ino === expectedIno) {
        await fs.unlink(lockPath).catch(() => {
          // Another process may have already removed it.
        });
      } else {
        logger.debug('Lock file inode changed, not unlinking (owned by another process)', {
          lockPath,
          ourIno: expectedIno,
          currentIno: pathStat.ino,
        });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        return;
      }

      logger.warn('Failed to stat lock file during cleanup', {
        lockPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async tryHandleStaleLockAfterTimeout(
    lockPath: string,
    staleRetryCount: number
  ): Promise<{ staleRemoved: boolean; newCount: number }> {
    if (staleRetryCount >= this.options.maxStaleRetries) {
      return { staleRemoved: false, newCount: staleRetryCount };
    }

    const removed = await this.tryRemoveStaleLock(lockPath);
    if (!removed) {
      return { staleRemoved: false, newCount: staleRetryCount };
    }

    await this.sleep(this.options.initialRetryDelayMs);
    return { staleRemoved: true, newCount: staleRetryCount + 1 };
  }

  private async tryRemoveStaleLock(lockPath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(lockPath);
      const lockAge = Date.now() - stats.mtimeMs;

      if (lockAge < this.options.staleThresholdMs) {
        return false;
      }

      logger.warn('Attempting to remove stale lock file', {
        lockPath,
        lockAgeMs: lockAge,
        inode: stats.ino,
      });

      return await this.verifyAndUnlinkStaleLock(lockPath, stats.ino);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        return true;
      }

      logger.warn('Failed to check stale lock file', {
        lockPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async verifyAndUnlinkStaleLock(lockPath: string, expectedIno: number): Promise<boolean> {
    try {
      const verifyStats = await fs.stat(lockPath);
      if (verifyStats.ino !== expectedIno) {
        logger.debug('Lock file inode changed, not removing (new lock created)', {
          lockPath,
          originalIno: expectedIno,
          currentIno: verifyStats.ino,
        });
        return false;
      }

      return await this.unlinkStaleLock(lockPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        return true;
      }

      logger.warn('Failed to verify lock file before removal', {
        lockPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async unlinkStaleLock(lockPath: string): Promise<boolean> {
    try {
      await fs.unlink(lockPath);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        return true;
      }

      logger.warn('Failed to unlink stale lock file', {
        lockPath,
        error: error instanceof Error ? error.message : String(error),
        code,
      });
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
