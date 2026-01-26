import { SessionStatus } from '@prisma-gen/client.js';
import { GitClientFactory } from '../clients/git.client.js';
import {
  claudeSessionAccessor,
  terminalSessionAccessor,
  workspaceAccessor,
} from '../resource_accessors/index.js';
import { createLogger } from './logger.service.js';

const logger = createLogger('reconciliation');

class ReconciliationService {
  /**
   * Main reconciliation - just ensures workspaces have worktrees
   */
  async reconcile(): Promise<void> {
    await this.reconcileWorkspaces();
  }

  /**
   * Create worktrees for ACTIVE workspaces that don't have one
   */
  private async reconcileWorkspaces(): Promise<void> {
    const workspacesNeedingWorktree = await workspaceAccessor.findNeedingWorktree();

    for (const workspace of workspacesNeedingWorktree) {
      try {
        await this.createWorktreeForWorkspace(workspace.id);
        logger.info('Created worktree for workspace', {
          workspaceId: workspace.id,
        });
      } catch (error) {
        logger.error('Failed to create worktree', error as Error, {
          workspaceId: workspace.id,
        });
      }
    }
  }

  /**
   * Create a worktree for a workspace
   */
  private async createWorktreeForWorkspace(workspaceId: string): Promise<void> {
    const workspace = await workspaceAccessor.findByIdWithProject(workspaceId);
    if (!workspace?.project) {
      throw new Error(`Workspace ${workspaceId} not found or has no project`);
    }

    const project = workspace.project;
    const gitClient = GitClientFactory.forProject({
      repoPath: project.repoPath,
      worktreeBasePath: project.worktreeBasePath,
    });

    const worktreeName = `workspace-${workspaceId}`;
    const baseBranch = workspace.branchName ?? project.defaultBranch;

    const worktreeInfo = await gitClient.createWorktree(worktreeName, baseBranch);
    const worktreePath = gitClient.getWorktreePath(worktreeName);

    await workspaceAccessor.update(workspaceId, {
      worktreePath,
      branchName: worktreeInfo.branchName,
    });
  }

  /**
   * Cleanup orphaned Claude processes on startup
   */
  async cleanupOrphans(): Promise<void> {
    // Find Claude sessions that claim to be running
    const sessionsWithPid = await claudeSessionAccessor.findWithPid();

    for (const session of sessionsWithPid) {
      if (session.claudeProcessPid) {
        const isRunning = this.isProcessRunning(session.claudeProcessPid);
        if (!isRunning) {
          // Process is not actually running, update the database
          await claudeSessionAccessor.update(session.id, {
            status: SessionStatus.IDLE,
            claudeProcessPid: null,
          });
          logger.info('Marked orphaned session as idle', {
            sessionId: session.id,
          });
        }
      }
    }

    // Same for terminal sessions
    const terminalSessionsWithPid = await terminalSessionAccessor.findWithPid();

    for (const session of terminalSessionsWithPid) {
      if (session.pid) {
        const isRunning = this.isProcessRunning(session.pid);
        if (!isRunning) {
          await terminalSessionAccessor.update(session.id, {
            status: SessionStatus.IDLE,
            pid: null,
          });
          logger.info('Marked orphaned terminal session as idle', {
            sessionId: session.id,
          });
        }
      }
    }
  }

  /**
   * Check if a process is running by PID.
   * Returns true if process exists (even if we can't signal it due to permissions).
   */
  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0); // Signal 0 just checks if process exists
      return true;
    } catch (error) {
      // ESRCH = no such process (not running)
      // EPERM = permission denied (process exists but we can't signal it)
      const err = error as NodeJS.ErrnoException;
      return err.code === 'EPERM';
    }
  }
}

export const reconciliationService = new ReconciliationService();
