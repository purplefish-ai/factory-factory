import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createLogger } from '@/backend/services/logger.service';

const logger = createLogger('file-lock-mutex');

const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 50;
const DEFAULT_LOCK_MAX_RETRY_DELAY_MS = 500;
const DEFAULT_LOCK_MAX_STALE_RETRIES = 3;
const DEFAULT_LOCK_STALE_THRESHOLD_MS = 60 * 60 * 1000;
const MIN_LOCK_STALE_THRESHOLD_MS = 1000;
const DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS = 10_000;
const MIN_LOCK_HEARTBEAT_INTERVAL_MS = 100;
const LOCK_FILE_FORMAT_VERSION = 1;

interface LockFileMetadata {
  version: number;
  lockId: string;
  pid: number;
  createdAt: string;
}

export interface FileLockMutexOptions {
  acquireTimeoutMs: number;
  postTimeoutWaitMs: number;
  initialRetryDelayMs: number;
  maxRetryDelayMs: number;
  maxStaleRetries: number;
  staleThresholdMs: number;
  heartbeatIntervalMs: number;
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
    const staleThresholdMs = Math.max(
      options.staleThresholdMs ?? DEFAULT_LOCK_STALE_THRESHOLD_MS,
      MIN_LOCK_STALE_THRESHOLD_MS
    );
    const heartbeatIntervalUpperBoundMs = Math.max(
      MIN_LOCK_HEARTBEAT_INTERVAL_MS,
      Math.floor(staleThresholdMs / 3)
    );
    const heartbeatIntervalMs = Math.max(
      MIN_LOCK_HEARTBEAT_INTERVAL_MS,
      Math.min(
        options.heartbeatIntervalMs ?? DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS,
        heartbeatIntervalUpperBoundMs
      )
    );

    this.options = {
      acquireTimeoutMs,
      postTimeoutWaitMs: options.postTimeoutWaitMs ?? 0,
      initialRetryDelayMs: options.initialRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS,
      maxRetryDelayMs: options.maxRetryDelayMs ?? DEFAULT_LOCK_MAX_RETRY_DELAY_MS,
      maxStaleRetries: options.maxStaleRetries ?? DEFAULT_LOCK_MAX_STALE_RETRIES,
      staleThresholdMs,
      heartbeatIntervalMs,
    };
  }

  async acquire(lockPath: string): Promise<() => Promise<void>> {
    const startTime = Date.now();
    let retryDelay = this.options.initialRetryDelayMs;
    let staleRetryCount = 0;

    while (true) {
      try {
        const fileHandle = await fs.open(lockPath, 'wx');
        await this.writeLockMetadata(fileHandle, lockPath);
        const stopHeartbeat = this.startLockHeartbeat(fileHandle, lockPath);
        return this.createLockCleanup(fileHandle, lockPath, stopHeartbeat);
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

  private async writeLockMetadata(fileHandle: fs.FileHandle, lockPath: string): Promise<void> {
    const metadata: LockFileMetadata = {
      version: LOCK_FILE_FORMAT_VERSION,
      lockId: randomUUID(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };

    try {
      await fileHandle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf-8');
    } catch (error) {
      await fileHandle.close().catch((closeError) => {
        logger.warn('Failed to close lock file after metadata write failure', {
          lockPath,
          error: closeError instanceof Error ? closeError.message : String(closeError),
        });
      });
      await fs.unlink(lockPath).catch(() => {
        // Best-effort cleanup; another process may have already removed it.
      });
      throw error;
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

  private createLockCleanup(
    fileHandle: fs.FileHandle,
    lockPath: string,
    stopHeartbeat: () => Promise<void>
  ): () => Promise<void> {
    let released = false;

    return async () => {
      if (released) {
        return;
      }
      released = true;

      await stopHeartbeat();
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

  private startLockHeartbeat(fileHandle: fs.FileHandle, lockPath: string): () => Promise<void> {
    let stopping = false;
    let heartbeatInFlight = Promise.resolve();

    const heartbeatTimer = setInterval(() => {
      heartbeatInFlight = heartbeatInFlight.then(async () => {
        if (stopping) {
          return;
        }

        await this.touchLockHeartbeat(fileHandle, lockPath);
      });
    }, this.options.heartbeatIntervalMs);

    heartbeatTimer.unref?.();

    return async () => {
      stopping = true;
      clearInterval(heartbeatTimer);
      await heartbeatInFlight;
    };
  }

  private async touchLockHeartbeat(fileHandle: fs.FileHandle, lockPath: string): Promise<void> {
    const now = new Date();

    try {
      await fileHandle.utimes(now, now);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'EBADF' || code === 'ENOENT') {
        return;
      }

      logger.warn('Failed to update lock heartbeat', {
        lockPath,
        error: error instanceof Error ? error.message : String(error),
        code,
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
      const expectedLockId = await this.readLockId(lockPath);

      if (lockAge < this.options.staleThresholdMs) {
        return false;
      }

      logger.warn('Attempting to remove stale lock file', {
        lockPath,
        lockAgeMs: lockAge,
        lockId: expectedLockId,
      });

      return await this.claimAndRemoveStaleLock(lockPath, expectedLockId);
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

  private async readLockId(lockPath: string): Promise<string | undefined> {
    try {
      const contents = await fs.readFile(lockPath, 'utf-8');
      const metadata: unknown = JSON.parse(contents);
      if (typeof metadata !== 'object' || metadata === null || !('lockId' in metadata)) {
        return undefined;
      }
      return typeof metadata.lockId === 'string' ? metadata.lockId : undefined;
    } catch {
      return undefined;
    }
  }

  private async claimAndRemoveStaleLock(
    lockPath: string,
    expectedLockId: string | undefined
  ): Promise<boolean> {
    const claimedPath = this.createStaleClaimPath(lockPath);

    try {
      await fs.rename(lockPath, claimedPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        return true;
      }

      logger.warn('Failed to claim stale lock file', {
        lockPath,
        claimedPath,
        error: error instanceof Error ? error.message : String(error),
        code,
      });
      return false;
    }

    try {
      const claimedStats = await fs.stat(claimedPath);
      const claimedLockId = await this.readLockId(claimedPath);

      const lockIdentityChanged =
        expectedLockId !== claimedLockId &&
        (expectedLockId !== undefined || claimedLockId !== undefined);

      if (lockIdentityChanged) {
        logger.debug('Claimed lock identity changed, restoring lock file', {
          lockPath,
          expectedLockId,
          claimedLockId,
        });
        await this.restoreClaimedLock(lockPath, claimedPath);
        return false;
      }

      const claimedLockAge = Date.now() - claimedStats.mtimeMs;
      if (claimedLockAge < this.options.staleThresholdMs) {
        logger.debug('Claimed lock is no longer stale, restoring lock file', {
          lockPath,
          claimedPath,
          lockAgeMs: claimedLockAge,
        });
        await this.restoreClaimedLock(lockPath, claimedPath);
        return false;
      }

      return await this.unlinkStaleLock(claimedPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        return true;
      }

      logger.warn('Failed to verify claimed stale lock before removal', {
        lockPath,
        claimedPath,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.restoreClaimedLock(lockPath, claimedPath);
      return false;
    }
  }

  private createStaleClaimPath(lockPath: string): string {
    const directory = path.dirname(lockPath);
    const basename = path.basename(lockPath);
    return path.join(directory, `.${basename}.stale-${process.pid}-${Date.now()}-${randomUUID()}`);
  }

  private async restoreClaimedLock(lockPath: string, claimedPath: string): Promise<void> {
    try {
      await fs.link(claimedPath, lockPath);
      await fs.unlink(claimedPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        return;
      }

      if (code === 'EEXIST') {
        logger.debug('Lock path already exists while restoring claimed lock', {
          lockPath,
          claimedPath,
        });
        return;
      }

      logger.warn('Failed to restore claimed lock file', {
        lockPath,
        claimedPath,
        error: error instanceof Error ? error.message : String(error),
        code,
      });
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
