/**
 * Worktree Management Service
 *
 * Handles git worktree cleanup, orphan detection, and management.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, rmSync } from 'fs';
import { createLogger } from './logger.service.js';
import { taskAccessor, epicAccessor } from '../resource_accessors/index.js';

const execAsync = promisify(exec);
const logger = createLogger('worktree');

/**
 * Worktree information
 */
export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  isDetached: boolean;
}

/**
 * Orphaned worktree information
 */
export interface OrphanedWorktree extends WorktreeInfo {
  reason: 'no_task' | 'deleted_epic' | 'completed_task' | 'unknown';
  taskId?: string;
  epicId?: string;
}

/**
 * Cleanup result
 */
export interface CleanupResult {
  cleaned: number;
  failed: number;
  details: Array<{
    path: string;
    success: boolean;
    error?: string;
  }>;
}

/**
 * WorktreeService class
 */
export class WorktreeService {
  private repoPath: string;

  constructor(repoPath?: string) {
    this.repoPath = repoPath || process.cwd();
  }

  /**
   * List all git worktrees
   */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    try {
      const { stdout } = await execAsync('git worktree list --porcelain', {
        cwd: this.repoPath,
      });

      const worktrees: WorktreeInfo[] = [];
      let current: Partial<WorktreeInfo> = {};

      for (const line of stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
          current.path = line.substring(9);
        } else if (line.startsWith('HEAD ')) {
          current.commit = line.substring(5);
        } else if (line.startsWith('branch ')) {
          current.branch = line.substring(7);
          current.isDetached = false;
        } else if (line === 'detached') {
          current.isDetached = true;
          current.branch = 'detached';
        } else if (line === '') {
          if (current.path) {
            worktrees.push(current as WorktreeInfo);
          }
          current = {};
        }
      }

      // Don't forget the last entry
      if (current.path) {
        worktrees.push(current as WorktreeInfo);
      }

      return worktrees;
    } catch (error) {
      logger.error('Failed to list worktrees', error as Error);
      return [];
    }
  }

  /**
   * Find orphaned worktrees (worktrees without corresponding tasks)
   */
  async findOrphanedWorktrees(): Promise<OrphanedWorktree[]> {
    const worktrees = await this.listWorktrees();
    const orphaned: OrphanedWorktree[] = [];

    for (const worktree of worktrees) {
      // Skip the main worktree
      if (worktree.path === this.repoPath) {
        continue;
      }

      // Try to extract task ID from branch name
      // Expected format: task-{taskId} or epic-{epicId}/task-{taskId}
      const taskMatch = worktree.branch.match(/task-([a-zA-Z0-9]+)/);
      const epicMatch = worktree.branch.match(/epic-([a-zA-Z0-9]+)/);

      let isOrphaned = false;
      let reason: OrphanedWorktree['reason'] = 'unknown';
      let taskId: string | undefined;
      let epicId: string | undefined;

      if (taskMatch) {
        taskId = taskMatch[1];
        const task = await taskAccessor.findById(taskId);

        if (!task) {
          isOrphaned = true;
          reason = 'no_task';
        } else if (task.state === 'COMPLETED' || task.state === 'FAILED') {
          isOrphaned = true;
          reason = 'completed_task';
          epicId = task.epicId;
        }
      }

      if (epicMatch && !isOrphaned) {
        epicId = epicMatch[1];
        const epic = await epicAccessor.findById(epicId);

        if (!epic) {
          isOrphaned = true;
          reason = 'deleted_epic';
        } else if (epic.state === 'COMPLETED' || epic.state === 'CANCELLED') {
          isOrphaned = true;
          reason = 'deleted_epic';
        }
      }

      // If we couldn't identify the worktree, check if it's old
      if (!taskMatch && !epicMatch) {
        // Mark unidentified worktrees as potentially orphaned
        isOrphaned = true;
        reason = 'unknown';
      }

      if (isOrphaned) {
        orphaned.push({
          ...worktree,
          reason,
          taskId,
          epicId,
        });
      }
    }

    logger.info('Found orphaned worktrees', { count: orphaned.length });
    return orphaned;
  }

  /**
   * Remove a single worktree
   */
  async removeWorktree(worktreePath: string, force = false): Promise<boolean> {
    try {
      // Check if path exists
      if (!existsSync(worktreePath)) {
        logger.warn('Worktree path does not exist', { path: worktreePath });
        return true; // Already gone
      }

      // Use git worktree remove
      const forceFlag = force ? '--force' : '';
      await execAsync(`git worktree remove ${forceFlag} "${worktreePath}"`, {
        cwd: this.repoPath,
      });

      logger.info('Worktree removed', { path: worktreePath });
      return true;
    } catch (error) {
      logger.error('Failed to remove worktree', error as Error, {
        path: worktreePath,
      });

      // If git worktree remove failed, try force removal
      if (force) {
        try {
          rmSync(worktreePath, { recursive: true, force: true });
          await execAsync('git worktree prune', { cwd: this.repoPath });
          logger.info('Worktree force removed', { path: worktreePath });
          return true;
        } catch (forceError) {
          logger.error('Failed to force remove worktree', forceError as Error);
          return false;
        }
      }

      return false;
    }
  }

  /**
   * Cleanup all orphaned worktrees
   */
  async cleanupOrphanedWorktrees(force = false): Promise<CleanupResult> {
    const orphaned = await this.findOrphanedWorktrees();
    const result: CleanupResult = {
      cleaned: 0,
      failed: 0,
      details: [],
    };

    for (const worktree of orphaned) {
      const success = await this.removeWorktree(worktree.path, force);

      result.details.push({
        path: worktree.path,
        success,
        error: success ? undefined : 'Failed to remove worktree',
      });

      if (success) {
        result.cleaned++;
      } else {
        result.failed++;
      }
    }

    logger.info('Worktree cleanup completed', {
      cleaned: result.cleaned,
      failed: result.failed,
    });

    return result;
  }

  /**
   * Prune stale worktree entries
   */
  async pruneWorktrees(): Promise<void> {
    try {
      await execAsync('git worktree prune', { cwd: this.repoPath });
      logger.info('Worktrees pruned');
    } catch (error) {
      logger.error('Failed to prune worktrees', error as Error);
    }
  }

  /**
   * Get worktree statistics
   */
  async getWorktreeStats(): Promise<{
    total: number;
    orphaned: number;
    byReason: Record<string, number>;
  }> {
    const worktrees = await this.listWorktrees();
    const orphaned = await this.findOrphanedWorktrees();

    const byReason: Record<string, number> = {};
    for (const o of orphaned) {
      byReason[o.reason] = (byReason[o.reason] || 0) + 1;
    }

    return {
      total: worktrees.length - 1, // Exclude main worktree
      orphaned: orphaned.length,
      byReason,
    };
  }

  /**
   * Create a worktree for a task
   */
  async createWorktreeForTask(
    taskId: string,
    epicId: string,
    branchName: string,
    baseBranch = 'main'
  ): Promise<string> {
    const worktreePath = `/tmp/factoryfactory/worktrees/${epicId}/${taskId}`;

    try {
      // Ensure parent directory exists
      await execAsync(`mkdir -p $(dirname "${worktreePath}")`);

      // Create the worktree
      await execAsync(
        `git worktree add -b ${branchName} "${worktreePath}" ${baseBranch}`,
        { cwd: this.repoPath }
      );

      logger.info('Worktree created', {
        taskId,
        epicId,
        path: worktreePath,
        branch: branchName,
      });

      return worktreePath;
    } catch (error) {
      logger.error('Failed to create worktree', error as Error, {
        taskId,
        epicId,
        branchName,
      });
      throw error;
    }
  }

  /**
   * Remove worktree for a task
   */
  async removeWorktreeForTask(taskId: string): Promise<boolean> {
    const task = await taskAccessor.findById(taskId);

    if (!task?.worktreePath) {
      logger.debug('No worktree path for task', { taskId });
      return true;
    }

    return this.removeWorktree(task.worktreePath, true);
  }
}

// Export singleton instance
export const worktreeService = new WorktreeService();
