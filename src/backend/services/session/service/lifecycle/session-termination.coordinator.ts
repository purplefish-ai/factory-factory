import { randomUUID } from 'node:crypto';
import { createLogger } from '@/backend/services/logger.service';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpRuntimeManager } from '@/backend/services/session/service/acp';
import type { SessionLifecycleWorkspaceBridge } from '@/backend/services/session/service/bridges';
import { acpTraceLogger } from '@/backend/services/session/service/logging/acp-trace-logger.service';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import {
  SessionLifecycleEventKind,
  SessionLifecycleEventReason,
  SessionStatus,
} from '@/shared/core';
import {
  createInitialSessionRuntimeState,
  type SessionRuntimeState,
} from '@/shared/session-runtime';
import type { AcpEventProcessor } from './acp-event-processor';
import type { SessionPermissionService } from './session.permission.service';
import type { SessionPromptTurnCompletionService } from './session.prompt-turn-completion.service';
import type { SessionRepository } from './session.repository';
import type { SessionRetryService } from './session.retry.service';
import type { SessionLifecycleEventService } from './session-lifecycle-event.service';
import type { SessionLifecycleGate } from './session-lifecycle-gate';
import { isStaleLoadingRuntime } from './session-runtime-state.helpers';
import type { SessionWorkflowFinalizer } from './session-workflow-finalizer';

const logger = createLogger('session');
const SHUTDOWN_LIFECYCLE_RECORD_TIMEOUT_MS = 1000;
const SHUTDOWN_SESSION_STOP_MESSAGE = 'Session stopped by the system.';

export type SessionStopReason =
  | 'USER_STOP'
  | 'SESSION_CLOSED'
  | 'WORKSPACE_ARCHIVED'
  | 'SYSTEM_STOP';

export type StopSessionOptions = {
  cleanupTransientRatchetSession?: boolean;
  recordLifecycleEvent?: boolean;
  reason?: SessionStopReason;
};

const SESSION_STOP_MESSAGES: Record<SessionStopReason, string> = {
  USER_STOP: 'Session stopped by you.',
  SESSION_CLOSED: 'Session closed by you.',
  WORKSPACE_ARCHIVED: 'Session stopped because the workspace was archived.',
  SYSTEM_STOP: 'Session stopped by the system.',
};

export type SessionTerminationCoordinatorDependencies = {
  repository: Pick<
    SessionRepository,
    'getSessionById' | 'getSessionsByWorkspaceId' | 'updateSessionIfStatus'
  >;
  retryService: Pick<SessionRetryService, 'run'>;
  runtimeManager: Pick<
    AcpRuntimeManager,
    | 'getClient'
    | 'isSessionWorking'
    | 'isStopInProgress'
    | 'isSessionRunning'
    | 'isBrowseOnlySession'
    | 'stopAndQuiesce'
    | 'beginShutdown'
    | 'stopAllClients'
  >;
  sessionDomainService: Pick<
    SessionDomainService,
    'clearQueuedWork' | 'getRuntimeSnapshot' | 'setRuntimeSnapshot'
  >;
  sessionPermissionService: Pick<SessionPermissionService, 'cancelPendingRequests'>;
  acpEventProcessor: Pick<
    AcpEventProcessor,
    | 'clearSessionState'
    | 'clearStreamingState'
    | 'clearReplaySuppression'
    | 'finalizeOrphanedToolCalls'
    | 'clearPendingToolCalls'
    | 'getWorkspaceId'
  >;
  promptTurnCompletionService: Pick<
    SessionPromptTurnCompletionService,
    'clearSession' | 'clearAll'
  >;
  lifecycleEventService: Pick<SessionLifecycleEventService, 'record'>;
  lifecycleGate: Pick<SessionLifecycleGate, 'reserveStop' | 'reserveShutdown'>;
  workflowFinalizer: Pick<
    SessionWorkflowFinalizer,
    'finalizeDeliberateStop' | 'clearInactiveSession'
  >;
  getWorkspaceBridge: () => Pick<SessionLifecycleWorkspaceBridge, 'markSessionIdle'> | null;
  onBeforeStopSession?: (sessionId: string) => void;
};

export class SessionTerminationCoordinator {
  constructor(private readonly dependencies: SessionTerminationCoordinatorDependencies) {}

  async stopSession(sessionId: string, options?: StopSessionOptions): Promise<void> {
    const stopReservation = this.dependencies.lifecycleGate.reserveStop(sessionId);
    if (!stopReservation) {
      logger.debug('Session stop already in progress', { sessionId });
      return;
    }

    const stopInvocationId = randomUUID();
    try {
      await this.stopSessionWithBarrier(sessionId, stopInvocationId, options);
    } finally {
      stopReservation.release();
    }
  }

  async stopWorkspaceSessions(
    workspaceId: string,
    options?: { reason?: SessionStopReason }
  ): Promise<void> {
    const sessions = await this.dependencies.repository.getSessionsByWorkspaceId(workspaceId);
    const stopErrors: unknown[] = [];

    for (const session of sessions) {
      const stopOptions = this.getWorkspaceSessionStopOptions(
        session,
        options?.reason ?? 'SYSTEM_STOP'
      );
      if (!stopOptions) {
        continue;
      }
      try {
        await this.stopSession(session.id, stopOptions);
      } catch (error) {
        logger.error('Failed to stop workspace session', {
          sessionId: session.id,
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
        stopErrors.push(error);
      }
    }

    if (stopErrors.length > 0) {
      throw new Error(
        `Failed to stop ${stopErrors.length} workspace session${stopErrors.length === 1 ? '' : 's'}`
      );
    }

    logger.info('Stopped all workspace sessions', { workspaceId, count: sessions.length });
  }

  async stopAllClients(timeoutMs = 5000): Promise<void> {
    this.dependencies.promptTurnCompletionService.clearAll();
    const shutdownSessionIds = this.dependencies.runtimeManager.beginShutdown();
    const activeShutdownSessionIds = shutdownSessionIds.filter(
      (sessionId) => !this.dependencies.runtimeManager.isBrowseOnlySession(sessionId)
    );
    this.dependencies.lifecycleGate.reserveShutdown(activeShutdownSessionIds);

    await this.recordShutdownLifecycleEvents(activeShutdownSessionIds);

    try {
      await this.dependencies.runtimeManager.stopAllClients(timeoutMs);
    } catch (error) {
      logger.error('Failed to stop ACP clients during shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async stopSessionWithBarrier(
    sessionId: string,
    stopInvocationId: string,
    options?: StopSessionOptions
  ): Promise<void> {
    this.dependencies.promptTurnCompletionService.clearSession(sessionId);
    this.dependencies.onBeforeStopSession?.(sessionId);
    this.dependencies.sessionDomainService.clearQueuedWork(sessionId, { emitSnapshot: true });
    const session = await this.loadSessionForStop(sessionId);
    const workspaceId =
      session?.workspaceId ?? this.dependencies.acpEventProcessor.getWorkspaceId(sessionId);
    const reason = options?.reason ?? 'SYSTEM_STOP';

    if (workspaceId && options?.recordLifecycleEvent !== false) {
      await this.dependencies.lifecycleEventService.record({
        workspaceId,
        sessionId,
        kind: SessionLifecycleEventKind.SESSION_STOPPED,
        reason,
        message: SESSION_STOP_MESSAGES[reason],
        dedupeKey: `session-stop:${stopInvocationId}`,
      });
    }

    const current = this.getRuntimeSnapshot(sessionId);
    this.dependencies.sessionDomainService.setRuntimeSnapshot(sessionId, {
      ...current,
      phase: 'stopping',
      activity: 'IDLE',
      updatedAt: new Date().toISOString(),
    });

    this.dependencies.acpEventProcessor.clearStreamingState(sessionId);
    this.dependencies.acpEventProcessor.clearReplaySuppression(sessionId);
    this.dependencies.sessionPermissionService.cancelPendingRequests(sessionId);

    let stopClientFailed = false;
    try {
      await this.dependencies.runtimeManager.stopAndQuiesce(sessionId);
    } catch (error) {
      stopClientFailed = true;
      logger.warn('Error stopping ACP session runtime; continuing cleanup', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.finalizeOrphanedToolCalls(sessionId, 'session_stop');
      await this.updateStoppedSessionState(sessionId);
      this.dependencies.sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      });
      this.markWorkspaceSessionIdleOnStop(workspaceId, sessionId);
      this.dependencies.acpEventProcessor.clearSessionState(sessionId);

      if (!stopClientFailed) {
        const shouldCleanupTransientRatchetSession =
          options?.cleanupTransientRatchetSession ?? true;
        await this.dependencies.workflowFinalizer.finalizeDeliberateStop({
          session,
          sessionId,
          cleanupTransientRatchetSession: shouldCleanupTransientRatchetSession,
        });
      }

      try {
        this.dependencies.workflowFinalizer.clearInactiveSession(sessionId, 'manual_stop');
        logger.info('ACP session stopped', {
          sessionId,
          ...(stopClientFailed ? { runtimeStopFailed: true } : {}),
        });
      } finally {
        acpTraceLogger.closeSession(sessionId);
      }
    }
  }

  private getWorkspaceSessionStopOptions(
    session: { id: string; status: SessionStatus },
    reason: SessionStopReason
  ): StopSessionOptions | null {
    const browseOnlyClient = this.dependencies.runtimeManager.isBrowseOnlySession(session.id);
    const activeClient = this.dependencies.runtimeManager.isSessionRunning(session.id);
    if (!(session.status === SessionStatus.RUNNING || activeClient || browseOnlyClient)) {
      return null;
    }
    return {
      reason,
      ...(browseOnlyClient && !activeClient ? { recordLifecycleEvent: false } : {}),
    };
  }

  private getRuntimeSnapshot(sessionId: string): SessionRuntimeState {
    const fallback = createInitialSessionRuntimeState();
    const persisted = this.dependencies.sessionDomainService.getRuntimeSnapshot(sessionId);
    const base = persisted ?? fallback;

    const acpClient = this.dependencies.runtimeManager.getClient(sessionId);
    if (acpClient) {
      const isWorking = this.dependencies.runtimeManager.isSessionWorking(sessionId);
      return {
        phase: isWorking ? 'running' : 'idle',
        processState: 'alive',
        activity: isWorking ? 'WORKING' : 'IDLE',
        updatedAt: base.updatedAt,
      };
    }

    if (this.dependencies.runtimeManager.isStopInProgress(sessionId)) {
      return {
        ...base,
        phase: 'stopping',
        updatedAt: base.updatedAt,
      };
    }

    if (isStaleLoadingRuntime(base)) {
      return {
        ...base,
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: base.updatedAt,
      };
    }

    return base;
  }

  private finalizeOrphanedToolCalls(sessionId: string, reason: string): void {
    try {
      this.dependencies.acpEventProcessor.finalizeOrphanedToolCalls(sessionId, reason);
    } catch (error) {
      logger.warn('Failed finalizing orphaned ACP tool calls', {
        sessionId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      this.dependencies.acpEventProcessor.clearPendingToolCalls(sessionId);
    }
  }

  private markWorkspaceSessionIdleOnStop(workspaceId: string | undefined, sessionId: string): void {
    const workspaceBridge = this.dependencies.getWorkspaceBridge();
    if (!(workspaceId && workspaceBridge)) {
      return;
    }

    try {
      workspaceBridge.markSessionIdle(workspaceId, sessionId);
    } catch (error) {
      logger.warn('Failed to mark workspace session idle during stop', {
        sessionId,
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async loadSessionForStop(sessionId: string): Promise<AgentSessionRecord | null> {
    try {
      return await this.dependencies.retryService.run(
        () => this.dependencies.repository.getSessionById(sessionId),
        {
          attempts: 2,
          operationName: 'loadSessionForStop',
          context: { sessionId },
        }
      );
    } catch (error) {
      logger.warn('Failed to load session before stop; continuing with process shutdown', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async recordShutdownLifecycleEvent(sessionId: string): Promise<void> {
    const session = await this.loadSessionForStop(sessionId);
    const workspaceId =
      session?.workspaceId ?? this.dependencies.acpEventProcessor.getWorkspaceId(sessionId);
    if (!workspaceId) {
      logger.warn('Skipped shutdown lifecycle event without workspace owner', { sessionId });
      return;
    }
    await this.dependencies.lifecycleEventService.record({
      workspaceId,
      sessionId,
      kind: SessionLifecycleEventKind.SESSION_STOPPED,
      reason: SessionLifecycleEventReason.SYSTEM_STOP,
      message: SHUTDOWN_SESSION_STOP_MESSAGE,
      dedupeKey: `session-stop:${randomUUID()}`,
    });
  }

  private async recordShutdownLifecycleEvents(sessionIds: string[]): Promise<void> {
    const resultsPromise = Promise.allSettled(
      sessionIds.map((sessionId) => this.recordShutdownLifecycleEvent(sessionId))
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const results = await Promise.race([
      resultsPromise,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), SHUTDOWN_LIFECYCLE_RECORD_TIMEOUT_MS);
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (results === null) {
      logger.warn('Timed out recording shutdown lifecycle events; continuing shutdown', {
        timeoutMs: SHUTDOWN_LIFECYCLE_RECORD_TIMEOUT_MS,
      });
      return;
    }
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        logger.warn('Failed recording shutdown lifecycle event; continuing shutdown', {
          sessionId: sessionIds[index],
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  private async updateStoppedSessionState(sessionId: string): Promise<void> {
    try {
      await this.dependencies.retryService.run(
        () =>
          this.dependencies.repository.updateSessionIfStatus(
            sessionId,
            { status: SessionStatus.IDLE },
            [SessionStatus.RUNNING]
          ),
        {
          attempts: 2,
          operationName: 'updateStoppedSessionState',
          context: { sessionId },
        }
      );
    } catch (error) {
      logger.warn('Failed to update session state during stop; continuing cleanup', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
