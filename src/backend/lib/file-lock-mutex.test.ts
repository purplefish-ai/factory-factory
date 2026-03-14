import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileLockMutex, FileLockTimeoutError } from './file-lock-mutex';

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

describe('FileLockMutex', () => {
  it('acquires and releases a lock file', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-lock-mutex-'));
    const lockPath = path.join(baseDir, 'test.lock');
    const mutex = new FileLockMutex();

    try {
      const release = await mutex.acquire(lockPath);
      expect(await exists(lockPath)).toBe(true);

      await release();
      expect(await exists(lockPath)).toBe(false);
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('times out when lock is held and stale retries are disabled', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-lock-mutex-'));
    const lockPath = path.join(baseDir, 'held.lock');
    await fs.writeFile(lockPath, 'held', 'utf-8');

    const mutex = new FileLockMutex({
      acquireTimeoutMs: 40,
      initialRetryDelayMs: 5,
      maxRetryDelayMs: 10,
      maxStaleRetries: 0,
      staleThresholdMs: 10_000,
    });

    try {
      await expect(mutex.acquire(lockPath)).rejects.toBeInstanceOf(FileLockTimeoutError);
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('keeps waiting during post-timeout window and acquires once lock is released', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-lock-mutex-'));
    const lockPath = path.join(baseDir, 'contention.lock');

    const holder = new FileLockMutex({
      acquireTimeoutMs: 20,
      postTimeoutWaitMs: 120,
      initialRetryDelayMs: 5,
      maxRetryDelayMs: 10,
      maxStaleRetries: 0,
      staleThresholdMs: 10_000,
    });
    const contender = new FileLockMutex({
      acquireTimeoutMs: 20,
      postTimeoutWaitMs: 120,
      initialRetryDelayMs: 5,
      maxRetryDelayMs: 10,
      maxStaleRetries: 0,
      staleThresholdMs: 10_000,
    });

    try {
      const releaseHolder = await holder.acquire(lockPath);
      setTimeout(() => {
        void releaseHolder();
      }, 40);

      const releaseContender = await contender.acquire(lockPath);
      await releaseContender();
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('removes stale lock and acquires it', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-lock-mutex-'));
    const lockPath = path.join(baseDir, 'stale.lock');
    await fs.writeFile(lockPath, 'stale', 'utf-8');

    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, staleTime, staleTime);

    const mutex = new FileLockMutex({
      acquireTimeoutMs: 30,
      postTimeoutWaitMs: 50,
      initialRetryDelayMs: 5,
      maxRetryDelayMs: 10,
      maxStaleRetries: 2,
      staleThresholdMs: 20,
    });

    try {
      const release = await mutex.acquire(lockPath);
      expect(await exists(lockPath)).toBe(true);
      await release();
      expect(await exists(lockPath)).toBe(false);
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('removes stale lock with zero post-timeout window', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-lock-mutex-'));
    const lockPath = path.join(baseDir, 'stale-zero-post.lock');
    await fs.writeFile(lockPath, 'stale', 'utf-8');

    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, staleTime, staleTime);

    const mutex = new FileLockMutex({
      acquireTimeoutMs: 30,
      postTimeoutWaitMs: 0,
      initialRetryDelayMs: 5,
      maxRetryDelayMs: 10,
      maxStaleRetries: 2,
      staleThresholdMs: 20,
    });

    try {
      const release = await mutex.acquire(lockPath);
      expect(await exists(lockPath)).toBe(true);
      await release();
      expect(await exists(lockPath)).toBe(false);
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('does not treat an active lock as stale while heartbeat is updating mtime', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-lock-mutex-'));
    const lockPath = path.join(baseDir, 'heartbeat.lock');

    const holder = new FileLockMutex({
      heartbeatIntervalMs: 100,
    });
    const contender = new FileLockMutex({
      acquireTimeoutMs: 100,
      postTimeoutWaitMs: 1200,
      initialRetryDelayMs: 5,
      maxRetryDelayMs: 10,
      maxStaleRetries: 2,
      staleThresholdMs: 1000,
    });

    try {
      const releaseHolder = await holder.acquire(lockPath);

      await expect(contender.acquire(lockPath)).rejects.toBeInstanceOf(FileLockTimeoutError);
      expect(await exists(lockPath)).toBe(true);

      await releaseHolder();
      expect(await exists(lockPath)).toBe(false);
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('clamps staleThresholdMs so zero does not allow lock stealing', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-lock-mutex-'));
    const lockPath = path.join(baseDir, 'zero-threshold.lock');
    const holder = new FileLockMutex();
    const contender = new FileLockMutex({
      acquireTimeoutMs: 20,
      postTimeoutWaitMs: 40,
      initialRetryDelayMs: 5,
      maxRetryDelayMs: 10,
      maxStaleRetries: 1,
      staleThresholdMs: 0,
    });

    try {
      const releaseHolder = await holder.acquire(lockPath);
      await expect(contender.acquire(lockPath)).rejects.toBeInstanceOf(FileLockTimeoutError);
      await releaseHolder();
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('does not derive stale threshold from acquireTimeoutMs', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-lock-mutex-'));
    const lockPath = path.join(baseDir, 'timeout-zero-default-threshold.lock');
    const holder = new FileLockMutex();
    const contender = new FileLockMutex({
      acquireTimeoutMs: 0,
      postTimeoutWaitMs: 30,
      initialRetryDelayMs: 5,
      maxRetryDelayMs: 10,
      maxStaleRetries: 1,
    });

    try {
      const releaseHolder = await holder.acquire(lockPath);
      await expect(contender.acquire(lockPath)).rejects.toBeInstanceOf(FileLockTimeoutError);
      await releaseHolder();
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('does not unlink a replaced lock file on release', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-lock-mutex-'));
    const lockPath = path.join(baseDir, 'replaced.lock');
    const mutex = new FileLockMutex();

    try {
      const release = await mutex.acquire(lockPath);

      await fs.unlink(lockPath);
      await fs.writeFile(lockPath, 'replacement', 'utf-8');

      await release();
      expect(await exists(lockPath)).toBe(true);
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });
});
