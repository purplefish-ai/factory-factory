import { SessionStatus } from '@prisma-gen/client';
import { ClaudeProcess, type ClaudeProcessOptions } from '../claude/process.js';
import { claudeSessionAccessor, workspaceAccessor } from '../resource_accessors/index.js';
import { createLogger } from './logger.service.js';

const logger = createLogger('session');

// Store active Claude processes by session ID
const activeClaudeProcesses = new Map<string, ClaudeProcess>();

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

    const workspace = await workspaceAccessor.findById(session.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${session.workspaceId}`);
    }

    const workingDir = workspace.worktreePath;
    if (!workingDir) {
      throw new Error('Workspace has no worktree path');
    }

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
      await claudeSessionAccessor.update(sessionId, { claudeSessionId });
    });

    process.on('exit', async () => {
      activeClaudeProcesses.delete(sessionId);
      await claudeSessionAccessor.update(sessionId, {
        status: SessionStatus.COMPLETED,
        claudeProcessPid: null,
      });
    });

    logger.info('Claude session started', { sessionId, pid });
  }

  /**
   * Stop a Claude session gracefully
   */
  async stopClaudeSession(sessionId: string): Promise<void> {
    const process = activeClaudeProcesses.get(sessionId);
    if (!process) {
      // Process not in memory, just update DB
      await claudeSessionAccessor.update(sessionId, {
        status: SessionStatus.IDLE,
        claudeProcessPid: null,
      });
      return;
    }

    await process.interrupt();
    activeClaudeProcesses.delete(sessionId);

    await claudeSessionAccessor.update(sessionId, {
      status: SessionStatus.IDLE,
      claudeProcessPid: null,
    });

    logger.info('Claude session stopped', { sessionId });
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
}

export const sessionService = new SessionService();
