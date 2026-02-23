import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileAtomic } from '@/backend/lib/atomic-file';
import { pathExists } from '@/backend/lib/file-helpers';
import { FileLockMutex } from '@/backend/lib/file-lock-mutex';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import { gitOpsService } from '@/backend/services/git-ops.service';
import { createLogger } from '@/backend/services/logger.service';
import { resumeModesSchema } from '@/shared/schemas/persisted-stores.schema';

const logger = createLogger('worktree-lifecycle');
const RESUME_MODE_FILENAME = '.ff-resume-modes.json';
const RESUME_MODE_LOCK_FILENAME = '.ff-resume-modes.json.lock';

const LOCK_ACQUIRE_TIMEOUT_MS = 5000;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_MAX_RETRY_DELAY_MS = 500;
const LOCK_MAX_STALE_RETRIES = 3;
const LOCK_STALE_THRESHOLD_MS = LOCK_ACQUIRE_TIMEOUT_MS * 5;
const resumeModeFileLock = new FileLockMutex({
  acquireTimeoutMs: LOCK_ACQUIRE_TIMEOUT_MS,
  postTimeoutWaitMs: 0,
  initialRetryDelayMs: LOCK_RETRY_DELAY_MS,
  maxRetryDelayMs: LOCK_MAX_RETRY_DELAY_MS,
  maxStaleRetries: LOCK_MAX_STALE_RETRIES,
  staleThresholdMs: LOCK_STALE_THRESHOLD_MS,
});

async function readResumeModes(worktreeBasePath: string): Promise<Record<string, boolean>> {
  const filePath = path.join(worktreeBasePath, RESUME_MODE_FILENAME);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    try {
      const parsed = JSON.parse(content);
      const validated = resumeModesSchema.parse(parsed);
      return validated;
    } catch (error) {
      logger.warn('Failed to parse resume modes file; falling back to empty', {
        filePath,
        worktreeBasePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code && code !== 'ENOENT') {
      logger.warn('Failed to read resume modes file; falling back to empty', {
        filePath,
        worktreeBasePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {};
  }
}

async function writeResumeModes(
  worktreeBasePath: string,
  modes: Record<string, boolean>
): Promise<void> {
  const targetPath = path.join(worktreeBasePath, RESUME_MODE_FILENAME);
  await writeFileAtomic(targetPath, JSON.stringify(modes), { encoding: 'utf-8' });
}

export class WorktreePathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreePathSafetyError';
  }
}

export function assertWorktreePathSafe(worktreePath: string, worktreeBasePath: string): void {
  const resolvedWorktreePath = path.resolve(worktreePath);
  const resolvedBasePath = path.resolve(worktreeBasePath);
  const basePrefix = `${resolvedBasePath}${path.sep}`;

  if (resolvedWorktreePath === resolvedBasePath || !resolvedWorktreePath.startsWith(basePrefix)) {
    throw new WorktreePathSafetyError(
      'Workspace worktree path is outside the worktree base directory'
    );
  }
}

type WorkspaceWithProject = Exclude<
  Awaited<ReturnType<typeof workspaceAccessor.findByIdWithProject>>,
  null | undefined
>;

interface WorktreeCleanupOptions {
  commitUncommitted: boolean;
}

function getProjectOrThrow(workspace: WorkspaceWithProject) {
  const project = workspace.project;
  if (!(project?.repoPath && project.worktreeBasePath)) {
    throw new Error('Workspace project paths are missing');
  }
  return project;
}

class WorktreeLifecycleService {
  // DOM-04: Instance fields replace module-level globals
  private readonly initModes = new Map<string, boolean>();
  private readonly resumeModeLocks = new Map<string, Promise<void>>();

  private async withResumeModeLock<T>(
    worktreeBasePath: string,
    handler: () => Promise<T>
  ): Promise<T> {
    // First acquire in-process lock (for same-process coordination)
    const previous = this.resumeModeLocks.get(worktreeBasePath) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lock = previous.then(() => next);
    this.resumeModeLocks.set(worktreeBasePath, lock);
    await previous;

    // Then acquire cross-process file lock
    const lockPath = path.join(worktreeBasePath, RESUME_MODE_LOCK_FILENAME);
    let releaseLock: (() => Promise<void>) | undefined;

    try {
      // Ensure directory exists before creating lock file
      await fs.mkdir(worktreeBasePath, { recursive: true });
      releaseLock = await resumeModeFileLock.acquire(lockPath);
      return await handler();
    } finally {
      // Release file lock first
      if (releaseLock) {
        await releaseLock().catch((error) => {
          logger.warn('Error releasing file lock', {
            lockPath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }

      // Then release in-process lock
      release?.();
      if (this.resumeModeLocks.get(worktreeBasePath) === lock) {
        this.resumeModeLocks.delete(worktreeBasePath);
      }
    }
  }

  private async updateResumeModes(
    worktreeBasePath: string,
    handler: (modes: Record<string, boolean>) => void
  ): Promise<void> {
    await this.withResumeModeLock(worktreeBasePath, async () => {
      const modes = await readResumeModes(worktreeBasePath);
      handler(modes);
      await writeResumeModes(worktreeBasePath, modes);
    });
  }

  async setInitMode(
    workspaceId: string,
    useExistingBranch: boolean | undefined,
    worktreeBasePath?: string
  ): Promise<void> {
    if (useExistingBranch === undefined) {
      return;
    }
    this.initModes.set(workspaceId, useExistingBranch);
    if (worktreeBasePath) {
      await this.updateResumeModes(worktreeBasePath, (modes) => {
        modes[workspaceId] = useExistingBranch;
      });
    }
  }

  async getInitMode(workspaceId: string): Promise<boolean | undefined> {
    // First check in-memory cache for current-process initialization retries.
    if (this.initModes.has(workspaceId)) {
      return this.initModes.get(workspaceId);
    }

    // Then check the database creationSource field (canonical source).
    const workspace = await workspaceAccessor.findById(workspaceId);
    if (workspace?.creationSource === 'RESUME_BRANCH') {
      return true;
    }

    return undefined;
  }

  async clearInitMode(workspaceId: string, worktreeBasePath?: string): Promise<void> {
    this.initModes.delete(workspaceId);
    if (!worktreeBasePath) {
      return;
    }
    await this.updateResumeModes(worktreeBasePath, (modes) => {
      if (workspaceId in modes) {
        delete modes[workspaceId];
      }
    });
  }

  async cleanupWorkspaceWorktree(
    workspace: WorkspaceWithProject,
    options: WorktreeCleanupOptions
  ): Promise<void> {
    const worktreePath = workspace.worktreePath;
    if (!worktreePath) {
      return;
    }

    const project = getProjectOrThrow(workspace);
    assertWorktreePathSafe(worktreePath, project.worktreeBasePath);

    const worktreeExists = await pathExists(worktreePath);
    if (!worktreeExists) {
      return;
    }

    await gitOpsService.commitIfNeeded(worktreePath, workspace.name, options.commitUncommitted);
    await gitOpsService.removeWorktree(worktreePath, project);
  }
}

export const worktreeLifecycleService = new WorktreeLifecycleService();
