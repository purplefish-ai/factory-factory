/**
 * Worktree Management Service
 *
 * Handles git worktree cleanup, orphan detection, and management.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { gitCommand, validateBranchName } from '../lib/shell.js';
import { epicAccessor, taskAccessor } from '../resource_accessors/index.js';
import { createLogger } from './logger.service.js';

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
 * Parse a single line from git worktree --porcelain output
 */
function parseWorktreeLine(line: string, current: Partial<WorktreeInfo>): void {
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
  }
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
      const result = await gitCommand(['worktree', 'list', '--porcelain'], this.repoPath);

      const worktrees: WorktreeInfo[] = [];
      let current: Partial<WorktreeInfo> = {};

      for (const line of result.stdout.split('\n')) {
        if (line === '') {
          if (current.path) {
            worktrees.push(current as WorktreeInfo);
          }
          current = {};
        } else {
          parseWorktreeLine(line, current);
        }
      }

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
   * Check if a task-based worktree is orphaned
   */
  private async checkTaskOrphan(
    taskId: string
  ): Promise<{ isOrphaned: boolean; reason: OrphanedWorktree['reason']; epicId?: string }> {
    const task = await taskAccessor.findById(taskId);
    if (!task) {
      return { isOrphaned: true, reason: 'no_task' };
    }
    if (task.state === 'COMPLETED' || task.state === 'FAILED') {
      return { isOrphaned: true, reason: 'completed_task', epicId: task.epicId };
    }
    return { isOrphaned: false, reason: 'unknown' };
  }

  /**
   * Check if an epic-based worktree is orphaned
   */
  private async checkEpicOrphan(
    epicId: string
  ): Promise<{ isOrphaned: boolean; reason: OrphanedWorktree['reason'] }> {
    const epic = await epicAccessor.findById(epicId);
    if (!epic) {
      return { isOrphaned: true, reason: 'deleted_epic' };
    }
    if (epic.state === 'COMPLETED' || epic.state === 'CANCELLED') {
      return { isOrphaned: true, reason: 'deleted_epic' };
    }
    return { isOrphaned: false, reason: 'unknown' };
  }

  /**
   * Check a single worktree for orphan status
   */
  private async checkWorktreeOrphan(worktree: WorktreeInfo): Promise<{
    isOrphaned: boolean;
    reason: OrphanedWorktree['reason'];
    taskId?: string;
    epicId?: string;
  }> {
    const taskMatch = worktree.branch.match(/task-([a-zA-Z0-9]+)/);
    const epicMatch = worktree.branch.match(/epic-([a-zA-Z0-9]+)/);

    if (taskMatch) {
      const taskId = taskMatch[1];
      const result = await this.checkTaskOrphan(taskId);
      if (result.isOrphaned) {
        return { ...result, taskId, epicId: result.epicId };
      }
    }

    if (epicMatch) {
      const epicId = epicMatch[1];
      const result = await this.checkEpicOrphan(epicId);
      if (result.isOrphaned) {
        return { ...result, epicId };
      }
    }

    if (!(taskMatch || epicMatch)) {
      return { isOrphaned: true, reason: 'unknown' };
    }

    return { isOrphaned: false, reason: 'unknown' };
  }

  /**
   * Find orphaned worktrees (worktrees without corresponding tasks)
   */
  async findOrphanedWorktrees(): Promise<OrphanedWorktree[]> {
    const worktrees = await this.listWorktrees();
    const orphaned: OrphanedWorktree[] = [];

    for (const worktree of worktrees) {
      if (worktree.path === this.repoPath) {
        continue;
      }

      const result = await this.checkWorktreeOrphan(worktree);
      if (result.isOrphaned) {
        orphaned.push({
          ...worktree,
          reason: result.reason,
          taskId: result.taskId,
          epicId: result.epicId,
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

      // Use git worktree remove with spawn (safe - array args)
      const args = force
        ? ['worktree', 'remove', '--force', worktreePath]
        : ['worktree', 'remove', worktreePath];
      await gitCommand(args, this.repoPath);

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
          await gitCommand(['worktree', 'prune'], this.repoPath);
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
      await gitCommand(['worktree', 'prune'], this.repoPath);
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

    // Validate branch names to prevent injection
    const validatedBranch = validateBranchName(branchName);
    const validatedBaseBranch = validateBranchName(baseBranch);

    try {
      // SECURITY FIX: Use Node.js path.dirname() instead of shell command substitution
      // The old code `mkdir -p $(dirname "${worktreePath}")` was vulnerable to command injection
      // if epicId or taskId contained malicious characters like $() or backticks
      mkdirSync(dirname(worktreePath), { recursive: true });

      // Create the worktree using spawn with array args (safe - no shell interpretation)
      await gitCommand(
        ['worktree', 'add', '-b', validatedBranch, worktreePath, validatedBaseBranch],
        this.repoPath
      );

      logger.info('Worktree created', {
        taskId,
        epicId,
        path: worktreePath,
        branch: validatedBranch,
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
