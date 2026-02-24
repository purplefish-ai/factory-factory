/**
 * Advisory File Locking Service
 *
 * Provides per-workspace advisory file locks so multiple agents can coordinate
 * file access without trampling each other.
 *
 * Features:
 * - In-memory storage with file-based persistence
 * - TTL-based automatic expiration
 * - Workspace-scoped locks resolved from agentId
 *
 * Limitations:
 * - Single-process only: In-memory lock state is not shared across multiple
 *   Node.js processes. If running in a cluster, each process will have its
 *   own lock state. File persistence helps on restart but doesn't provide
 *   cross-process synchronization during runtime.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileAtomic } from '@/backend/lib/atomic-file';
import { agentSessionAccessor } from '@/backend/resource_accessors/agent-session.accessor';
import { SERVICE_INTERVAL_MS, SERVICE_TTL_SECONDS } from '@/backend/services/constants';
import { createLogger } from '@/backend/services/logger.service';
import type { PersistedLockStore } from '@/shared/schemas/persisted-stores.schema';
import { persistedLockStoreSchema } from '@/shared/schemas/persisted-stores.schema';

const logger = createLogger('file-lock');

// Lock persistence file name
const LOCK_FILE_NAME = 'advisory-locks.json';

// Context directory name
const CONTEXT_DIR_NAME = '.context';

/**
 * Represents a single file lock
 */
export interface FileLock {
  filePath: string;
  ownerId: string;
  ownerLabel?: string;
  acquiredAt: Date;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Internal lock store per workspace
 */
interface WorkspaceLockStore {
  workspaceId: string;
  worktreePath: string;
  locks: Map<string, FileLock>;
}

// Input types for public methods
export interface AcquireLockInput {
  filePath: string;
  ttlSeconds?: number;
  ownerLabel?: string;
  metadata?: Record<string, unknown>;
}

export interface ReleaseLockInput {
  filePath: string;
  force?: boolean;
}

export interface CheckLockInput {
  filePath: string;
}

export interface ListLocksInput {
  includeExpired?: boolean;
}

// Result types
export interface AcquireLockResult {
  acquired: boolean;
  filePath: string;
  expiresAt?: string;
  existingLock?: {
    ownerId: string;
    ownerLabel?: string;
    acquiredAt: string;
    expiresAt: string;
  };
}

export interface ReleaseLockResult {
  released: boolean;
  filePath: string;
  reason?: string;
}

export interface CheckLockResult {
  isLocked: boolean;
  filePath: string;
  lock?: {
    ownerId: string;
    ownerLabel?: string;
    acquiredAt: string;
    expiresAt: string;
    isOwnedByMe: boolean;
    metadata?: Record<string, unknown>;
  };
}

export interface ListLocksResult {
  locks: Array<{
    filePath: string;
    ownerId: string;
    ownerLabel?: string;
    acquiredAt: string;
    expiresAt: string;
    isOwnedByMe: boolean;
    isExpired: boolean;
    metadata?: Record<string, unknown>;
  }>;
  totalCount: number;
}

export interface ReleaseAllLocksResult {
  releasedCount: number;
  releasedPaths: string[];
}

/**
 * Workspace context resolved from agentId
 */
interface WorkspaceContext {
  workspaceId: string;
  worktreePath: string;
}

export class FileLockService {
  // In-memory storage: workspaceId -> WorkspaceLockStore
  private stores = new Map<string, WorkspaceLockStore>();

  // Track initialization promises to prevent race conditions during concurrent store creation
  private initializationPromises = new Map<string, Promise<WorkspaceLockStore>>();

  // Cleanup interval handle
  private cleanupInterval?: NodeJS.Timeout;
  private hasCheckedRuntime = false;

  /**
   * Warn when runtime hints indicate multiple Node.js processes.
   * Advisory locks are in-memory and only safe within a single process.
   */
  private warnIfMultiProcessRuntime(): void {
    const nodeUniqueId = this.readEnvSignal('NODE_UNIQUE_ID');
    const pmId = this.readEnvSignal('pm_id');
    const nodeAppInstance = this.readEnvSignal('NODE_APP_INSTANCE');

    const webConcurrencyRaw = process.env.WEB_CONCURRENCY;
    const webConcurrency =
      webConcurrencyRaw && Number.isFinite(Number(webConcurrencyRaw))
        ? Number(webConcurrencyRaw)
        : undefined;

    const isLikelyMultiProcess =
      nodeUniqueId !== undefined ||
      pmId !== undefined ||
      nodeAppInstance !== undefined ||
      (webConcurrency !== undefined && webConcurrency > 1);

    if (!isLikelyMultiProcess) {
      return;
    }

    logger.warn('File lock service detected likely multi-process runtime', {
      nodeUniqueId,
      pmId,
      nodeAppInstance,
      webConcurrency,
      impact:
        'Advisory locks are process-local only; use a distributed lock for cross-process coordination.',
    });
  }

  private ensureRuntimeWarningChecked(): void {
    if (this.hasCheckedRuntime) {
      return;
    }
    this.hasCheckedRuntime = true;
    this.warnIfMultiProcessRuntime();
  }

  private readEnvSignal(key: string): string | undefined {
    const value = process.env[key]?.trim();
    if (!value || value === 'undefined' || value === 'null') {
      return undefined;
    }
    return value;
  }

  /**
   * Resolve workspace context from agentId (session ID)
   */
  private async resolveWorkspaceContext(agentId: string): Promise<WorkspaceContext | null> {
    try {
      const session = await agentSessionAccessor.findById(agentId);
      if (!session?.workspace?.worktreePath) {
        return null;
      }
      return {
        workspaceId: session.workspaceId,
        worktreePath: session.workspace.worktreePath,
      };
    } catch (error) {
      logger.warn('Failed to resolve workspace context', {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get path to lock persistence file for a workspace
   */
  private getLockFilePath(worktreePath: string): string {
    return path.join(worktreePath, CONTEXT_DIR_NAME, LOCK_FILE_NAME);
  }

  /**
   * Ensure the .context directory exists
   */
  private async ensureContextDir(worktreePath: string): Promise<void> {
    const contextDir = path.join(worktreePath, CONTEXT_DIR_NAME);
    try {
      await fs.mkdir(contextDir, { recursive: true });
    } catch (error) {
      // Ignore EEXIST errors
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  /**
   * Load locks from disk for a workspace
   */
  private async loadFromDisk(worktreePath: string): Promise<Map<string, FileLock>> {
    const lockFilePath = this.getLockFilePath(worktreePath);
    const locks = new Map<string, FileLock>();

    try {
      const content = await fs.readFile(lockFilePath, 'utf-8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (error) {
        logger.warn('Failed to parse lock store JSON', {
          worktreePath,
          lockFilePath,
          error: error instanceof Error ? error.message : String(error),
        });
        return locks;
      }

      const persistedResult = persistedLockStoreSchema.safeParse(parsed);
      if (!persistedResult.success) {
        logger.warn('Lock store JSON failed schema validation', {
          worktreePath,
          lockFilePath,
          issues: persistedResult.error.issues.map((issue) => {
            const issuePath = issue.path.length > 0 ? issue.path.join('.') : '<root>';
            return `${issuePath}: ${issue.message}`;
          }),
        });
        return locks;
      }
      const persisted = persistedResult.data;

      const now = new Date();
      for (const lock of persisted.locks) {
        const expiresAt = new Date(lock.expiresAt);
        // Skip already expired locks
        if (expiresAt > now) {
          locks.set(lock.filePath, {
            filePath: lock.filePath,
            ownerId: lock.ownerId,
            ownerLabel: lock.ownerLabel,
            acquiredAt: new Date(lock.acquiredAt),
            expiresAt,
            metadata: lock.metadata,
          });
        }
      }

      logger.debug('Loaded locks from disk', {
        worktreePath,
        count: locks.size,
      });
    } catch (error) {
      // File doesn't exist is expected on first access
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('Failed to load locks from disk', {
          worktreePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return locks;
  }

  /**
   * Persist locks to disk for a workspace
   */
  private async persistToDisk(store: WorkspaceLockStore): Promise<void> {
    try {
      await this.ensureContextDir(store.worktreePath);
      const lockFilePath = this.getLockFilePath(store.worktreePath);

      const persisted: PersistedLockStore = {
        version: 1,
        workspaceId: store.workspaceId,
        locks: Array.from(store.locks.values()).map((lock) => ({
          filePath: lock.filePath,
          ownerId: lock.ownerId,
          ownerLabel: lock.ownerLabel,
          acquiredAt: lock.acquiredAt.toISOString(),
          expiresAt: lock.expiresAt.toISOString(),
          metadata: lock.metadata,
        })),
      };

      await writeFileAtomic(lockFilePath, JSON.stringify(persisted, null, 2), {
        encoding: 'utf-8',
      });
      logger.debug('Persisted locks to disk', {
        worktreePath: store.worktreePath,
        count: store.locks.size,
      });
    } catch (error) {
      // Log but don't fail - graceful degradation
      logger.warn('Failed to persist locks to disk', {
        worktreePath: store.worktreePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get or create lock store for a workspace
   * Uses promise deduplication to prevent race conditions during concurrent initialization
   */
  private async getOrCreateStore(context: WorkspaceContext): Promise<WorkspaceLockStore> {
    this.ensureRuntimeWarningChecked();

    // Check if store already exists
    const store = this.stores.get(context.workspaceId);
    if (store) {
      return store;
    }

    // Check if initialization is already in progress
    let initPromise = this.initializationPromises.get(context.workspaceId);
    if (!initPromise) {
      // Start initialization
      initPromise = (async () => {
        try {
          const locks = await this.loadFromDisk(context.worktreePath);
          const newStore: WorkspaceLockStore = {
            workspaceId: context.workspaceId,
            worktreePath: context.worktreePath,
            locks,
          };
          this.stores.set(context.workspaceId, newStore);
          return newStore;
        } finally {
          // Always clean up the promise, even on error, to allow retry
          this.initializationPromises.delete(context.workspaceId);
        }
      })();
      this.initializationPromises.set(context.workspaceId, initPromise);
    }

    return await initPromise;
  }

  /**
   * Normalize file path and verify it stays within the workspace
   */
  private normalizePath(filePath: string, worktreePath: string): string {
    // Remove leading slashes and normalize
    const normalized = path.normalize(filePath).replace(/^\/+/, '');

    // Prevent obvious path traversal patterns
    if (normalized.startsWith('..') || normalized.includes('/..') || normalized.includes('\\..')) {
      throw new Error('Path traversal not allowed');
    }

    // Resolve the full path and verify it stays within the workspace
    const fullPath = path.resolve(worktreePath, normalized);
    if (!fullPath.startsWith(worktreePath + path.sep) && fullPath !== worktreePath) {
      throw new Error('Path traversal not allowed');
    }

    return normalized;
  }

  /**
   * Clean up expired locks from a store
   * Returns number of locks cleaned up
   */
  private cleanupExpired(store: WorkspaceLockStore): number {
    const now = new Date();
    let cleaned = 0;

    for (const [filePath, lock] of store.locks.entries()) {
      if (lock.expiresAt <= now) {
        store.locks.delete(filePath);
        cleaned++;
        logger.debug('Cleaned up expired lock', {
          workspaceId: store.workspaceId,
          filePath,
          ownerId: lock.ownerId,
        });
      }
    }

    return cleaned;
  }

  /**
   * Check if a lock is expired
   */
  private isExpired(lock: FileLock): boolean {
    return lock.expiresAt <= new Date();
  }

  /**
   * Acquire a lock on a file
   */
  async acquireLock(agentId: string, input: AcquireLockInput): Promise<AcquireLockResult> {
    const context = await this.resolveWorkspaceContext(agentId);
    if (!context) {
      throw new Error('Could not resolve workspace for agent');
    }

    const normalizedPath = this.normalizePath(input.filePath, context.worktreePath);
    const store = await this.getOrCreateStore(context);

    // Lazy cleanup
    this.cleanupExpired(store);

    const existingLock = store.locks.get(normalizedPath);

    // Check if already locked by someone else (and not expired)
    if (existingLock && !this.isExpired(existingLock)) {
      return {
        acquired: false,
        filePath: normalizedPath,
        existingLock: {
          ownerId: existingLock.ownerId,
          ownerLabel: existingLock.ownerLabel,
          acquiredAt: existingLock.acquiredAt.toISOString(),
          expiresAt: existingLock.expiresAt.toISOString(),
        },
      };
    }

    // Acquire the lock
    const ttlSeconds = input.ttlSeconds ?? SERVICE_TTL_SECONDS.fileLockDefault;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    const newLock: FileLock = {
      filePath: normalizedPath,
      ownerId: agentId,
      ownerLabel: input.ownerLabel,
      acquiredAt: now,
      expiresAt,
      metadata: input.metadata,
    };

    store.locks.set(normalizedPath, newLock);

    // Persist to disk
    await this.persistToDisk(store);

    logger.info('Lock acquired', {
      workspaceId: context.workspaceId,
      filePath: normalizedPath,
      ownerId: agentId,
      expiresAt: expiresAt.toISOString(),
    });

    return {
      acquired: true,
      filePath: normalizedPath,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Release a lock on a file
   */
  async releaseLock(agentId: string, input: ReleaseLockInput): Promise<ReleaseLockResult> {
    const context = await this.resolveWorkspaceContext(agentId);
    if (!context) {
      throw new Error('Could not resolve workspace for agent');
    }

    const normalizedPath = this.normalizePath(input.filePath, context.worktreePath);
    const store = await this.getOrCreateStore(context);

    const existingLock = store.locks.get(normalizedPath);

    if (!existingLock) {
      return {
        released: false,
        filePath: normalizedPath,
        reason: 'not_locked',
      };
    }

    // Check ownership unless force is true
    if (!input.force && existingLock.ownerId !== agentId) {
      return {
        released: false,
        filePath: normalizedPath,
        reason: 'not_owner',
      };
    }

    store.locks.delete(normalizedPath);

    // Persist to disk
    await this.persistToDisk(store);

    logger.info('Lock released', {
      workspaceId: context.workspaceId,
      filePath: normalizedPath,
      ownerId: agentId,
      force: input.force,
    });

    return {
      released: true,
      filePath: normalizedPath,
    };
  }

  /**
   * Check if a file is locked
   */
  async checkLock(agentId: string, input: CheckLockInput): Promise<CheckLockResult> {
    const context = await this.resolveWorkspaceContext(agentId);
    if (!context) {
      throw new Error('Could not resolve workspace for agent');
    }

    const normalizedPath = this.normalizePath(input.filePath, context.worktreePath);
    const store = await this.getOrCreateStore(context);

    // Lazy cleanup
    this.cleanupExpired(store);

    const lock = store.locks.get(normalizedPath);

    if (!lock || this.isExpired(lock)) {
      return {
        isLocked: false,
        filePath: normalizedPath,
      };
    }

    return {
      isLocked: true,
      filePath: normalizedPath,
      lock: {
        ownerId: lock.ownerId,
        ownerLabel: lock.ownerLabel,
        acquiredAt: lock.acquiredAt.toISOString(),
        expiresAt: lock.expiresAt.toISOString(),
        isOwnedByMe: lock.ownerId === agentId,
        metadata: lock.metadata,
      },
    };
  }

  /**
   * List all locks in the workspace
   */
  async listLocks(agentId: string, input: ListLocksInput): Promise<ListLocksResult> {
    const context = await this.resolveWorkspaceContext(agentId);
    if (!context) {
      throw new Error('Could not resolve workspace for agent');
    }

    const store = await this.getOrCreateStore(context);

    // Optionally cleanup expired locks first
    if (!input.includeExpired) {
      this.cleanupExpired(store);
    }

    const locks = Array.from(store.locks.values())
      .filter((lock) => input.includeExpired || !this.isExpired(lock))
      .map((lock) => ({
        filePath: lock.filePath,
        ownerId: lock.ownerId,
        ownerLabel: lock.ownerLabel,
        acquiredAt: lock.acquiredAt.toISOString(),
        expiresAt: lock.expiresAt.toISOString(),
        isOwnedByMe: lock.ownerId === agentId,
        isExpired: this.isExpired(lock),
        metadata: lock.metadata,
      }));

    return {
      locks,
      totalCount: locks.length,
    };
  }

  /**
   * Release all locks held by the agent in the workspace
   */
  async releaseAllLocks(agentId: string): Promise<ReleaseAllLocksResult> {
    const context = await this.resolveWorkspaceContext(agentId);
    if (!context) {
      throw new Error('Could not resolve workspace for agent');
    }

    const store = await this.getOrCreateStore(context);
    const releasedPaths: string[] = [];

    for (const [filePath, lock] of store.locks.entries()) {
      if (lock.ownerId === agentId) {
        store.locks.delete(filePath);
        releasedPaths.push(filePath);
      }
    }

    if (releasedPaths.length > 0) {
      // Persist to disk
      await this.persistToDisk(store);

      logger.info('Released all locks for agent', {
        workspaceId: context.workspaceId,
        ownerId: agentId,
        count: releasedPaths.length,
      });
    }

    return {
      releasedCount: releasedPaths.length,
      releasedPaths,
    };
  }

  /**
   * Start the periodic cleanup interval
   */
  startCleanupInterval(intervalMs = SERVICE_INTERVAL_MS.fileLockCleanup): void {
    this.ensureRuntimeWarningChecked();

    if (this.cleanupInterval) {
      return; // Already running
    }

    this.cleanupInterval = setInterval(() => {
      void (async () => {
        let totalCleaned = 0;
        const modifiedStores: WorkspaceLockStore[] = [];

        for (const store of this.stores.values()) {
          const cleaned = this.cleanupExpired(store);
          if (cleaned > 0) {
            totalCleaned += cleaned;
            modifiedStores.push(store);
          }
        }

        // Persist modified stores
        for (const store of modifiedStores) {
          await this.persistToDisk(store);
        }

        if (totalCleaned > 0) {
          logger.info('Periodic lock cleanup completed', { cleaned: totalCleaned });
        }
      })();
    }, intervalMs);

    logger.info('Lock cleanup interval started', { intervalMs });
  }

  /**
   * Stop the periodic cleanup interval
   */
  stopCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
      logger.info('Lock cleanup interval stopped');
    }
  }

  /**
   * Clear all in-memory stores (for testing)
   */
  clearStores(): void {
    this.stores.clear();
    this.initializationPromises.clear();
  }
}

export const fileLockService = new FileLockService();
