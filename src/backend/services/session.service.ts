import { SessionStatus } from '@prisma-gen/client';
import { ClaudeProcess, type ClaudeProcessOptions } from '../claude/process';
import { claudeSessionAccessor, workspaceAccessor } from '../resource_accessors/index';
import { createLogger } from './logger.service';

const logger = createLogger('session');

// Store active Claude processes by session ID
const activeClaudeProcesses = new Map<string, ClaudeProcess>();

// Track sessions currently being stopped to prevent race conditions
const stoppingInProgress = new Set<string>();

class SessionService {
  /**
   * Start a Claude session
   */
  async startClaudeSession(sessionId: string, options?: { initialPrompt?: string }): Promise<void> {
    const session = await claudeSessionAccessor.findById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.status === SessionStatus.RUNNING) {
      throw new Error('Session is already running');
    }
    if (stoppingInProgress.has(sessionId)) {
      throw new Error('Session is currently being stopped');
    }

    const workspace = await workspaceAccessor.findById(session.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${session.workspaceId}`);
    }

    const workingDir = workspace.worktreePath;
    if (!workingDir) {
      throw new Error('Workspace has no worktree path');
    }

    // Mark workspace as having had sessions (for kanban backlog/waiting distinction)
    // Uses atomic conditional update - safe to call even if already true
    await workspaceAccessor.markHasHadSessions(workspace.id);

    // Build process options
    const processOptions: ClaudeProcessOptions = {
      workingDir,
      model: session.model,
      resumeSessionId: session.claudeSessionId ?? undefined,
      initialPrompt: options?.initialPrompt ?? 'Continue with the task.',
      permissionMode: 'bypassPermissions',
    };

    // Spawn Claude process
    const process = await ClaudeProcess.spawn(processOptions);
    const pid = process.getPid();

    // Store process reference
    activeClaudeProcesses.set(sessionId, process);

    // Update session with process info
    await claudeSessionAccessor.update(sessionId, {
      status: SessionStatus.RUNNING,
      claudeProcessPid: pid ?? null,
    });

    // Set up event handlers
    process.on('session_id', async (claudeSessionId) => {
      try {
        await claudeSessionAccessor.update(sessionId, { claudeSessionId });
      } catch (error) {
        logger.warn('Failed to update session with Claude session ID', {
          sessionId,
          claudeSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    process.on('exit', async () => {
      activeClaudeProcesses.delete(sessionId);
      try {
        await claudeSessionAccessor.update(sessionId, {
          status: SessionStatus.COMPLETED,
          claudeProcessPid: null,
        });
      } catch (error) {
        logger.warn('Failed to update session status on exit', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    logger.info('Claude session started', { sessionId, pid });
  }

  /**
   * Stop a Claude session gracefully
   */
  async stopClaudeSession(sessionId: string): Promise<void> {
    // Check if already stopping to prevent concurrent stop attempts
    if (stoppingInProgress.has(sessionId)) {
      logger.debug('Session stop already in progress', { sessionId });
      return;
    }

    const process = activeClaudeProcesses.get(sessionId);
    if (!process) {
      // Process not in memory, just update DB
      await claudeSessionAccessor.update(sessionId, {
        status: SessionStatus.IDLE,
        claudeProcessPid: null,
      });
      return;
    }

    // Mark as stopping to prevent concurrent access
    stoppingInProgress.add(sessionId);

    try {
      await process.interrupt();
    } catch (error) {
      logger.error('Failed to interrupt process', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Clean up after interrupt completes (success or failure)
      activeClaudeProcesses.delete(sessionId);
      stoppingInProgress.delete(sessionId);
    }

    await claudeSessionAccessor.update(sessionId, {
      status: SessionStatus.IDLE,
      claudeProcessPid: null,
    });

    logger.info('Claude session stopped', { sessionId });
  }

  /**
   * Stop all Claude sessions for a workspace
   */
  async stopWorkspaceSessions(workspaceId: string): Promise<void> {
    const sessions = await claudeSessionAccessor.findByWorkspaceId(workspaceId);

    for (const session of sessions) {
      if (session.status === SessionStatus.RUNNING || activeClaudeProcesses.has(session.id)) {
        try {
          await this.stopClaudeSession(session.id);
        } catch (error) {
          logger.error('Failed to stop workspace session', {
            sessionId: session.id,
            workspaceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    logger.info('Stopped all workspace sessions', { workspaceId, count: sessions.length });
  }

  /**
   * Get an active Claude process
   */
  getClaudeProcess(sessionId: string): ClaudeProcess | undefined {
    return activeClaudeProcesses.get(sessionId);
  }

  /**
   * Check if a session is running in memory
   */
  isSessionRunning(sessionId: string): boolean {
    const process = activeClaudeProcesses.get(sessionId);
    return process?.isRunning() ?? false;
  }

  /**
   * Check if a session is actively working (not just alive, but processing)
   */
  isSessionWorking(sessionId: string): boolean {
    const process = activeClaudeProcesses.get(sessionId);
    return process?.getStatus() === 'running';
  }

  /**
   * Check if any session in the given list is actively working
   */
  isAnySessionWorking(sessionIds: string[]): boolean {
    return sessionIds.some((id) => this.isSessionWorking(id));
  }
}

export const sessionService = new SessionService();
