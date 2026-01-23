/**
 * PR Conflict Resolution Service
 *
 * Handles PR creation failures, merge conflicts, and rebase issues.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskState } from '@prisma-gen/client';
import { decisionLogAccessor, mailAccessor, taskAccessor } from '../resource_accessors/index.js';
import { createLogger } from './logger.service.js';

const execAsync = promisify(exec);
const logger = createLogger('pr-conflict');

/**
 * PR creation result
 */
export interface PrCreationResult {
  success: boolean;
  prUrl?: string;
  error?: string;
  retryable: boolean;
}

/**
 * Rebase result
 */
export interface RebaseResult {
  success: boolean;
  hasConflicts: boolean;
  conflictedFiles: string[];
  error?: string;
  autoResolved: boolean;
}

/**
 * Merge conflict info
 */
export interface MergeConflictInfo {
  file: string;
  conflictType: 'content' | 'delete' | 'rename';
  isSimple: boolean; // Can be auto-resolved
}

/**
 * PRConflictService class
 */
export class PrConflictService {
  /**
   * Attempt to create a PR with retries
   */
  async createPrWithRetry(
    worktreePath: string,
    branchName: string,
    title: string,
    body: string,
    baseBranch = 'main',
    maxRetries = 3
  ): Promise<PrCreationResult> {
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Push the branch first
        await execAsync(`git push -u origin ${branchName}`, {
          cwd: worktreePath,
        });

        // Create the PR using gh CLI
        const { stdout } = await execAsync(
          `gh pr create --base ${baseBranch} --head ${branchName} --title "${this.escapeBash(title)}" --body "${this.escapeBash(body)}"`,
          { cwd: worktreePath }
        );

        const prUrl = stdout.trim();
        logger.info('PR created successfully', { prUrl, branchName, attempt });

        return {
          success: true,
          prUrl,
          retryable: false,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        logger.warn(`PR creation attempt ${attempt} failed`, {
          branchName,
          error: lastError,
        });

        // Check if error is retryable
        if (this.isNonRetryableError(lastError)) {
          return {
            success: false,
            error: lastError,
            retryable: false,
          };
        }

        // Wait before retry with exponential backoff
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        }
      }
    }

    return {
      success: false,
      error: lastError,
      retryable: true,
    };
  }

  /**
   * Check if an error is non-retryable
   */
  private isNonRetryableError(error: string): boolean {
    const nonRetryablePatterns = [
      'A pull request already exists',
      'No commits between',
      'Repository not found',
      'Permission denied',
      'Authentication failed',
    ];

    return nonRetryablePatterns.some((pattern) =>
      error.toLowerCase().includes(pattern.toLowerCase())
    );
  }

  /**
   * Attempt a rebase with conflict detection
   */
  async attemptRebase(worktreePath: string, baseBranch = 'main'): Promise<RebaseResult> {
    try {
      // Fetch latest changes
      await execAsync(`git fetch origin ${baseBranch}`, { cwd: worktreePath });

      // Attempt rebase
      await execAsync(`git rebase origin/${baseBranch}`, { cwd: worktreePath });

      logger.info('Rebase succeeded', { worktreePath, baseBranch });

      return {
        success: true,
        hasConflicts: false,
        conflictedFiles: [],
        autoResolved: false,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Check for conflicts
      const hasConflicts = errorMsg.includes('CONFLICT') || errorMsg.includes('could not apply');

      if (hasConflicts) {
        const conflicts = await this.getConflictedFiles(worktreePath);

        // Check if conflicts are simple enough to auto-resolve
        const simpleConflicts = conflicts.filter((c) => c.isSimple);

        if (simpleConflicts.length === conflicts.length && conflicts.length > 0) {
          // Try auto-resolution
          const autoResolved = await this.attemptAutoResolve(worktreePath, conflicts);

          if (autoResolved) {
            return {
              success: true,
              hasConflicts: true,
              conflictedFiles: conflicts.map((c) => c.file),
              autoResolved: true,
            };
          }
        }

        // Abort the rebase if we can't resolve
        await this.abortRebase(worktreePath);

        return {
          success: false,
          hasConflicts: true,
          conflictedFiles: conflicts.map((c) => c.file),
          error: 'Merge conflicts detected',
          autoResolved: false,
        };
      }

      logger.error('Rebase failed', error as Error, { worktreePath });

      return {
        success: false,
        hasConflicts: false,
        conflictedFiles: [],
        error: errorMsg,
        autoResolved: false,
      };
    }
  }

  /**
   * Get list of conflicted files
   */
  private async getConflictedFiles(worktreePath: string): Promise<MergeConflictInfo[]> {
    try {
      const { stdout } = await execAsync('git diff --name-only --diff-filter=U', {
        cwd: worktreePath,
      });

      const files = stdout.trim().split('\n').filter(Boolean);
      const conflicts: MergeConflictInfo[] = [];

      for (const file of files) {
        const conflict = await this.analyzeConflict(worktreePath, file);
        conflicts.push(conflict);
      }

      return conflicts;
    } catch {
      return [];
    }
  }

  /**
   * Analyze a conflicted file
   */
  private async analyzeConflict(worktreePath: string, file: string): Promise<MergeConflictInfo> {
    try {
      const { stdout } = await execAsync(`git diff "${file}"`, {
        cwd: worktreePath,
      });

      // Count conflict markers
      const conflictMarkers = (stdout.match(/<<<<<<< HEAD/g) || []).length;

      // Simple conflicts have just one conflict region
      const isSimple = conflictMarkers === 1;

      return {
        file,
        conflictType: 'content',
        isSimple,
      };
    } catch {
      return {
        file,
        conflictType: 'content',
        isSimple: false,
      };
    }
  }

  /**
   * Attempt to auto-resolve simple conflicts
   */
  private async attemptAutoResolve(
    worktreePath: string,
    conflicts: MergeConflictInfo[]
  ): Promise<boolean> {
    try {
      // For now, we only auto-resolve if all conflicts are simple
      // and we accept "ours" (the rebasing branch) changes

      for (const conflict of conflicts) {
        if (!conflict.isSimple) {
          return false;
        }

        // Accept ours for simple conflicts
        await execAsync(`git checkout --ours "${conflict.file}"`, {
          cwd: worktreePath,
        });
        await execAsync(`git add "${conflict.file}"`, { cwd: worktreePath });
      }

      // Continue the rebase
      await execAsync('git rebase --continue', { cwd: worktreePath });

      logger.info('Auto-resolved conflicts', {
        files: conflicts.map((c) => c.file),
      });

      return true;
    } catch (error) {
      logger.warn('Auto-resolve failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Abort an in-progress rebase
   */
  async abortRebase(worktreePath: string): Promise<void> {
    try {
      await execAsync('git rebase --abort', { cwd: worktreePath });
      logger.info('Rebase aborted', { worktreePath });
    } catch (error) {
      logger.warn('Failed to abort rebase', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle rebase failure for a task
   */
  async handleRebaseFailure(
    taskId: string,
    supervisorId: string,
    conflictedFiles: string[]
  ): Promise<void> {
    const task = await taskAccessor.findById(taskId);
    if (!task) return;

    // Mark task as blocked
    await taskAccessor.update(taskId, {
      state: TaskState.BLOCKED,
      failureReason: `Rebase conflicts in: ${conflictedFiles.join(', ')}`,
    });

    // Send mail to supervisor
    await mailAccessor.create({
      fromAgentId: task.assignedAgentId || undefined,
      toAgentId: supervisorId,
      subject: `Rebase Conflict: ${task.title}`,
      body: `Task "${task.title}" has rebase conflicts that could not be auto-resolved.\n\nConflicted files:\n${conflictedFiles.map((f) => `- ${f}`).join('\n')}\n\nPlease review and resolve the conflicts, or mark the task for manual intervention.`,
    });

    // Log decision
    if (task.assignedAgentId) {
      await decisionLogAccessor.createManual(
        task.assignedAgentId,
        'Task blocked due to rebase conflicts',
        `Conflicts in: ${conflictedFiles.join(', ')}`,
        JSON.stringify({ taskId, conflictedFiles })
      );
    }

    logger.warn('Task blocked due to rebase conflicts', {
      taskId,
      conflictedFiles,
    });
  }

  /**
   * Handle PR creation failure
   */
  async handlePrCreationFailure(
    taskId: string,
    workerId: string,
    supervisorId: string,
    error: string
  ): Promise<void> {
    const task = await taskAccessor.findById(taskId);
    if (!task) return;

    // Log the failure
    await decisionLogAccessor.createManual(
      workerId,
      'PR creation failed',
      error,
      JSON.stringify({ taskId, error })
    );

    // Send escalation to supervisor
    await mailAccessor.create({
      fromAgentId: workerId,
      toAgentId: supervisorId,
      subject: `PR Creation Failed: ${task.title}`,
      body: `Failed to create PR for task "${task.title}".\n\nError: ${error}\n\nPlease investigate and provide guidance.`,
    });

    logger.error('PR creation failed, escalated to supervisor', {
      taskId,
      error,
    });
  }

  /**
   * Check for PR review timeout
   */
  async checkPrReviewTimeout(
    taskId: string,
    prCreatedAt: Date,
    timeoutMinutes = 60
  ): Promise<boolean> {
    const now = new Date();
    const elapsedMinutes = (now.getTime() - prCreatedAt.getTime()) / (1000 * 60);

    if (elapsedMinutes > timeoutMinutes) {
      const task = await taskAccessor.findById(taskId);
      if (!task) return false;

      // Send notification to human
      await mailAccessor.create({
        isForHuman: true,
        subject: `PR Review Timeout: ${task.title}`,
        body: `The PR for task "${task.title}" has been waiting for review for ${Math.round(elapsedMinutes)} minutes.\n\nPR URL: ${task.prUrl}\n\nPlease review or dismiss if no longer needed.`,
      });

      logger.warn('PR review timeout', {
        taskId,
        elapsedMinutes,
        timeoutMinutes,
      });

      return true;
    }

    return false;
  }

  /**
   * Escape string for bash command
   */
  private escapeBash(str: string): string {
    return str.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  }
}

// Export singleton instance
export const prConflictService = new PrConflictService();
