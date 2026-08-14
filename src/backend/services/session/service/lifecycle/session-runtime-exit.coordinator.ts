import { randomUUID } from 'node:crypto';
import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type {
  AcpRuntimeEventHandlers,
  AcpRuntimeExitEvent,
  AcpRuntimePurpose,
} from '@/backend/services/session/service/acp';
import { acpTraceLogger } from '@/backend/services/session/service/logging/acp-trace-logger.service';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import {
  SessionLifecycleEventKind,
  SessionLifecycleEventReason,
  SessionStatus,
} from '@/shared/core';
import type { AcpEventProcessor } from './acp-event-processor';
import type { SessionPermissionService } from './session.permission.service';
import type { SessionPromptTurnCompletionService } from './session.prompt-turn-completion.service';
import type { SessionRepository } from './session.repository';
import type { SessionLifecycleEventService } from './session-lifecycle-event.service';
import type { SessionLifecycleGate } from './session-lifecycle-gate';
import type { SessionWorkflowFinalizer } from './session-workflow-finalizer';

const logger = createLogger('session');

type RuntimeExitCoordinatorDependencies = {
  repository: Pick<SessionRepository, 'getSessionById' | 'updateSession'>;
  sessionDomainService: Pick<SessionDomainService, 'markError' | 'markProcessExit'>;
  sessionPermissionService: Pick<SessionPermissionService, 'cancelPendingRequests'>;
  acpEventProcessor: Pick<
    AcpEventProcessor,
    | 'createRuntimeEventHandler'
    | 'clearSessionState'
    | 'finalizeOrphanedToolCalls'
    | 'clearPendingToolCalls'
    | 'handleAcpLog'
  >;
  promptTurnCompletionService: Pick<SessionPromptTurnCompletionService, 'clearSession'>;
  lifecycleEventService: Pick<SessionLifecycleEventService, 'record'>;
  lifecycleGate: Pick<SessionLifecycleGate, 'isSessionStopping' | 'releaseShutdown'>;
  workflowFinalizer: Pick<SessionWorkflowFinalizer, 'finalizeRuntimeExit' | 'clearInactiveSession'>;
  onSessionExit?: (sessionId: string) => void;
};

function getPersistedStatusForExitCode(exitCode: number | null): SessionStatus {
  return exitCode === 0 ? SessionStatus.COMPLETED : SessionStatus.FAILED;
}

export class SessionRuntimeExitCoordinator {
  constructor(private readonly dependencies: RuntimeExitCoordinatorDependencies) {}

  createHandlers(input: {
    sessionId: string;
    purpose: AcpRuntimePurpose;
    persistProviderSessionId: boolean;
  }): AcpRuntimeEventHandlers {
    const runtimeEventHandler = this.dependencies.acpEventProcessor.createRuntimeEventHandler(
      input.sessionId
    );
    const legacyIncarnationId = randomUUID();

    return {
      ...runtimeEventHandler,
      ...(input.persistProviderSessionId
        ? { onSessionId: this.createProviderSessionIdHandler() }
        : {}),
      onRuntimeExit: async (event) => {
        await this.handleRuntimeExitEvent(event);
      },
      onExit: async (sessionId, exitCode) => {
        await this.handleRuntimeExitEvent({
          sessionId,
          exitCode,
          incarnationId: legacyIncarnationId,
          purpose: input.purpose,
          managed: this.dependencies.lifecycleGate.isSessionStopping(sessionId),
        });
      },
      onError: (sessionId, error) => {
        this.handleRuntimeError(sessionId, error, input.purpose);
      },
      onAcpLog: (sessionId, payload) => {
        this.dependencies.acpEventProcessor.handleAcpLog(sessionId, payload);
      },
    };
  }

  async handleExit(event: AcpRuntimeExitEvent): Promise<void> {
    const deliberate =
      event.managed || this.dependencies.lifecycleGate.isSessionStopping(event.sessionId);

    try {
      this.dependencies.sessionDomainService.markProcessExit(event.sessionId, event.exitCode);
      const session = await this.dependencies.repository.getSessionById(event.sessionId);
      if (!session) {
        logger.warn('Failed to find ACP session on exit', { sessionId: event.sessionId });
        return;
      }

      await this.updatePersistedStatus(event);
      await this.recordUnexpectedExitIfNeeded(session, event, deliberate);
      await this.dependencies.workflowFinalizer.finalizeRuntimeExit({
        session,
        sessionId: event.sessionId,
        exitCode: event.exitCode,
        deliberate,
      });
    } catch (error) {
      logger.warn('Failed to process ACP session exit', {
        sessionId: event.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      try {
        this.dependencies.workflowFinalizer.clearInactiveSession(event.sessionId, 'runtime_exit');
      } finally {
        acpTraceLogger.closeSession(event.sessionId);
      }
    }
  }

  private createProviderSessionIdHandler(): NonNullable<AcpRuntimeEventHandlers['onSessionId']> {
    return async (sessionId, providerSessionId) => {
      try {
        await this.dependencies.repository.updateSession(sessionId, { providerSessionId });
        acpTraceLogger.log(sessionId, 'runtime_metadata', {
          type: 'provider_session_id',
          providerSessionId,
        });
        logger.debug('Updated session with ACP providerSessionId', {
          sessionId,
          providerSessionId,
        });
      } catch (error) {
        logger.warn('Failed to update session with ACP providerSessionId', {
          sessionId,
          providerSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
  }

  private async handleRuntimeExitEvent(event: AcpRuntimeExitEvent): Promise<void> {
    this.dependencies.lifecycleGate.releaseShutdown(event.sessionId);
    if (event.purpose === 'browse') {
      this.dependencies.acpEventProcessor.clearSessionState(event.sessionId);
      acpTraceLogger.closeSession(event.sessionId);
      return;
    }
    this.prepareRuntimeExit(event.sessionId, event.exitCode);
    await this.handleExit(event);
  }

  private handleRuntimeError(sessionId: string, error: Error, purpose: AcpRuntimePurpose): void {
    acpTraceLogger.log(sessionId, 'runtime_error', {
      message: error.message,
      stack: error.stack,
    });
    if (purpose !== 'browse') {
      this.dependencies.sessionDomainService.markError(sessionId, error.message);
    }
    logger.error('ACP client error', {
      sessionId,
      error: error.message,
      stack: error.stack,
    });
  }

  private prepareRuntimeExit(sessionId: string, exitCode: number | null): void {
    this.dependencies.promptTurnCompletionService.clearSession(sessionId);
    this.dependencies.onSessionExit?.(sessionId);
    this.finalizeOrphanedToolCalls(sessionId);
    this.dependencies.acpEventProcessor.clearSessionState(sessionId);
    this.dependencies.sessionPermissionService.cancelPendingRequests(sessionId);
    acpTraceLogger.log(sessionId, 'runtime_exit', { exitCode });
  }

  private finalizeOrphanedToolCalls(sessionId: string): void {
    try {
      this.dependencies.acpEventProcessor.finalizeOrphanedToolCalls(sessionId, 'runtime_exit');
    } catch (error) {
      logger.warn('Failed finalizing orphaned ACP tool calls', {
        sessionId,
        reason: 'runtime_exit',
        error: error instanceof Error ? error.message : String(error),
      });
      this.dependencies.acpEventProcessor.clearPendingToolCalls(sessionId);
    }
  }

  private async updatePersistedStatus(event: AcpRuntimeExitEvent): Promise<void> {
    const persistedStatus = getPersistedStatusForExitCode(event.exitCode);
    try {
      await this.dependencies.repository.updateSession(event.sessionId, {
        status: persistedStatus,
      });
      logger.debug('Updated ACP session status on exit', {
        sessionId: event.sessionId,
        exitCode: event.exitCode,
        status: persistedStatus,
      });
    } catch (error) {
      logger.warn('Failed to update ACP session status on exit', {
        sessionId: event.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async recordUnexpectedExitIfNeeded(
    session: AgentSessionRecord,
    event: AcpRuntimeExitEvent,
    deliberate: boolean
  ): Promise<void> {
    if (deliberate) {
      return;
    }

    await this.dependencies.lifecycleEventService.record({
      workspaceId: session.workspaceId,
      sessionId: event.sessionId,
      kind: SessionLifecycleEventKind.SESSION_STOPPED,
      reason: SessionLifecycleEventReason.UNEXPECTED_EXIT,
      message:
        event.exitCode === null
          ? 'Session stopped: agent process exited unexpectedly.'
          : `Session stopped: agent process exited unexpectedly (code ${event.exitCode}).`,
      dedupeKey: `process-exit:${event.incarnationId}:${event.exitCode ?? 'signal'}`,
    });
  }
}
