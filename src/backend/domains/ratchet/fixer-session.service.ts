import { agentSessionAccessor } from '@/backend/resource_accessors/agent-session.accessor';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import { configService } from '@/backend/services/config.service';
import { createLogger } from '@/backend/services/logger.service';
import { SessionStatus } from '@/shared/core';
import type { RatchetSessionBridge } from './bridges';
import { ratchetProviderResolverService } from './ratchet-provider-resolver.service';

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
  private sessionBridge: RatchetSessionBridge | null = null;

  configure(bridges: { session: RatchetSessionBridge }): void {
    this.sessionBridge = bridges.session;
  }

  private get session(): RatchetSessionBridge {
    if (!this.sessionBridge) {
      throw new Error(
        'FixerSessionService not configured: session bridge missing. Call configure() first.'
      );
    }
    return this.sessionBridge;
  }

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
    const provider = await ratchetProviderResolverService.resolveRatchetProvider({
      workspaceId,
    });
    const sessions = await agentSessionAccessor.findByWorkspaceId(workspaceId);
    const matching = sessions
      .filter(
        (s) =>
          s.workflow === workflow &&
          s.provider === provider &&
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

      const acquisitionResult = await this.acquireSessionDecision(input);

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
    input: AcquireAndDispatchInput
  ): Promise<SessionAcquisitionDecision> {
    const provider = await ratchetProviderResolverService.resolveRatchetProvider({
      workspaceId: input.workspaceId,
    });
    const acquisition = await agentSessionAccessor.acquireFixerSession({
      workspaceId: input.workspaceId,
      workflow: input.workflow,
      sessionName: input.sessionName,
      maxSessions: configService.getMaxSessionsPerWorkspace(),
      provider,
      providerProjectPath: null,
    });

    if (acquisition.outcome === 'limit_reached') {
      return { action: 'limit_reached' };
    }

    if (acquisition.outcome === 'existing') {
      return this.decideExistingSessionAction(
        { id: acquisition.sessionId, status: acquisition.status },
        input.runningIdleAction
      );
    }

    return {
      action: 'start',
      sessionId: acquisition.sessionId,
    };
  }

  private decideExistingSessionAction(
    existingSession: { id: string; status: SessionStatus },
    runningIdleAction: RunningIdleSessionAction
  ): SessionAcquisitionDecision {
    const isWorking = this.session.isSessionWorking(existingSession.id);
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
      await this.session.startSession(acquisitionResult.sessionId, {
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
      await this.session.startSession(acquisitionResult.sessionId, {
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
    if (!this.session.isSessionRunning(sessionId)) {
      logger.warn('Could not send fixer message because session is not running', { sessionId });
      return false;
    }

    try {
      await this.session.sendSessionMessage(sessionId, prompt);
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
