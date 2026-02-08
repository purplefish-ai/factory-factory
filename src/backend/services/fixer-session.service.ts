import { SessionStatus } from '@prisma-gen/client';
import { SessionManager } from '../claude/session';
import { prisma } from '../db';
import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { configService } from './config.service';
import { createLogger } from './logger.service';
import { sessionService } from './session.service';

const logger = createLogger('fixer-session');

export type RunningIdleSessionAction = 'send_message' | 'restart' | 'already_active';

export interface AcquireAndDispatchInput {
  workspaceId: string;
  workflow: string;
  sessionName: string;
  buildPrompt: () => string | Promise<string>;
  runningIdleAction: RunningIdleSessionAction;
  dispatchMode?: 'start_with_prompt' | 'start_empty_and_send';
  beforeStart?: (params: { sessionId: string; prompt: string }) => void | Promise<void>;
  afterStart?: (params: { sessionId: string; prompt: string }) => void | Promise<void>;
}

export type AcquireAndDispatchResult =
  | { status: 'started'; sessionId: string; promptSent?: boolean }
  | { status: 'already_active'; sessionId: string; reason: 'working' | 'message_dispatched' }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string };

type SessionAcquisitionDecision =
  | { action: 'start' | 'restart' | 'send_message' | 'already_active'; sessionId: string }
  | { action: 'limit_reached' };

class FixerSessionService {
  private readonly pendingAcquisitions = new Map<string, Promise<AcquireAndDispatchResult>>();

  async acquireAndDispatch(input: AcquireAndDispatchInput): Promise<AcquireAndDispatchResult> {
    const key = `${input.workspaceId}:${input.workflow}`;
    const pending = this.pendingAcquisitions.get(key);
    if (pending) {
      logger.debug('Fixer acquisition already in progress', {
        workspaceId: input.workspaceId,
        workflow: input.workflow,
      });
      return pending;
    }

    const promise = this.doAcquireAndDispatch(input);
    this.pendingAcquisitions.set(key, promise);

    try {
      return await promise;
    } finally {
      this.pendingAcquisitions.delete(key);
    }
  }

  async getActiveSession(
    workspaceId: string,
    workflow: string
  ): Promise<{ id: string; status: SessionStatus } | null> {
    const sessions = await claudeSessionAccessor.findByWorkspaceId(workspaceId);
    const matching = sessions
      .filter(
        (s) =>
          s.workflow === workflow &&
          (s.status === SessionStatus.RUNNING || s.status === SessionStatus.IDLE)
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const active = matching[0];
    return active ? { id: active.id, status: active.status } : null;
  }

  private async doAcquireAndDispatch(
    input: AcquireAndDispatchInput
  ): Promise<AcquireAndDispatchResult> {
    const { workspaceId, workflow } = input;

    try {
      const workspace = await workspaceAccessor.findById(workspaceId);
      if (!workspace?.worktreePath) {
        logger.warn('Workspace not ready for fixer session', { workspaceId, workflow });
        return { status: 'skipped', reason: 'Workspace not ready (no worktree path)' };
      }

      const acquisitionResult = await prisma.$transaction(async (tx) =>
        this.acquireSessionDecision(tx, input)
      );

      if (acquisitionResult.action === 'limit_reached') {
        return { status: 'skipped', reason: 'Workspace session limit reached' };
      }

      return this.dispatchAcquiredSession(input, acquisitionResult);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to acquire and dispatch fixer session', error as Error, {
        workspaceId,
        workflow,
      });
      return { status: 'error', error: errorMessage };
    }
  }

  private async acquireSessionDecision(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    input: AcquireAndDispatchInput
  ): Promise<SessionAcquisitionDecision> {
    const { workspaceId, workflow } = input;
    const existingSession = await tx.claudeSession.findFirst({
      where: {
        workspaceId,
        workflow,
        status: { in: [SessionStatus.RUNNING, SessionStatus.IDLE] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingSession) {
      return this.decideExistingSessionAction(existingSession, input.runningIdleAction);
    }

    const allSessions = await tx.claudeSession.findMany({
      where: { workspaceId },
      select: { id: true },
    });

    const maxSessions = configService.getMaxSessionsPerWorkspace();
    if (allSessions.length >= maxSessions) {
      return { action: 'limit_reached' };
    }

    const recentSession = await tx.claudeSession.findFirst({
      where: { workspaceId, workflow: { not: workflow } },
      orderBy: { updatedAt: 'desc' },
      select: { model: true },
    });

    const model = recentSession?.model ?? 'sonnet';
    const workspace = await tx.workspace.findUnique({
      where: { id: workspaceId },
      select: { worktreePath: true },
    });
    const claudeProjectPath = workspace?.worktreePath
      ? SessionManager.getProjectPath(workspace.worktreePath)
      : null;

    const newSession = await tx.claudeSession.create({
      data: {
        workspaceId,
        workflow,
        name: input.sessionName,
        model,
        status: SessionStatus.IDLE,
        claudeProjectPath,
      },
    });

    return {
      action: 'start',
      sessionId: newSession.id,
    };
  }

  private decideExistingSessionAction(
    existingSession: { id: string; status: SessionStatus },
    runningIdleAction: RunningIdleSessionAction
  ): SessionAcquisitionDecision {
    const isWorking = sessionService.isSessionWorking(existingSession.id);
    if (isWorking) {
      return {
        action: 'already_active',
        sessionId: existingSession.id,
      };
    }

    if (existingSession.status === SessionStatus.RUNNING) {
      if (runningIdleAction === 'send_message') {
        return {
          action: 'send_message',
          sessionId: existingSession.id,
        };
      }

      if (runningIdleAction === 'already_active') {
        return {
          action: 'already_active',
          sessionId: existingSession.id,
        };
      }
    }

    return {
      action: 'restart',
      sessionId: existingSession.id,
    };
  }

  private async dispatchAcquiredSession(
    input: AcquireAndDispatchInput,
    acquisitionResult: Exclude<SessionAcquisitionDecision, { action: 'limit_reached' }>
  ): Promise<AcquireAndDispatchResult> {
    if (acquisitionResult.action === 'already_active') {
      return {
        status: 'already_active',
        sessionId: acquisitionResult.sessionId,
        reason: 'working',
      };
    }

    const prompt = await input.buildPrompt();

    if (acquisitionResult.action === 'send_message') {
      await this.sendMessageSafely(acquisitionResult.sessionId, prompt);

      return {
        status: 'already_active',
        sessionId: acquisitionResult.sessionId,
        reason: 'message_dispatched',
      };
    }

    await input.beforeStart?.({ sessionId: acquisitionResult.sessionId, prompt });

    if (input.dispatchMode === 'start_empty_and_send') {
      await sessionService.startClaudeSession(acquisitionResult.sessionId, {
        initialPrompt: '',
      });

      const promptSent = await this.sendMessageSafely(acquisitionResult.sessionId, prompt);

      await input.afterStart?.({ sessionId: acquisitionResult.sessionId, prompt });

      return {
        status: 'started',
        sessionId: acquisitionResult.sessionId,
        promptSent,
      };
    } else {
      await sessionService.startClaudeSession(acquisitionResult.sessionId, {
        initialPrompt: prompt,
      });
    }

    await input.afterStart?.({ sessionId: acquisitionResult.sessionId, prompt });

    return {
      status: 'started',
      sessionId: acquisitionResult.sessionId,
    };
  }

  private async sendMessageSafely(sessionId: string, prompt: string): Promise<boolean> {
    const client = sessionService.getClient(sessionId);
    if (!client) {
      logger.warn('Could not send fixer message because no client was found', { sessionId });
      return false;
    }

    try {
      await client.sendMessage(prompt);
      return true;
    } catch (error) {
      logger.warn('Failed to send fixer message', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

export const fixerSessionService = new FixerSessionService();
