import type { AutoIterationSessionBridge } from '@/backend/services/auto-iteration';
import type {
  sessionDataService,
  sessionDomainService,
  sessionLifecycleService,
  sessionService,
} from '@/backend/services/session';
import type { workspaceAutoIterationService } from '@/backend/services/workspace';
import { AutoIterationStatus, SessionStatus } from '@/shared/core';

type SessionDataService = Pick<
  typeof sessionDataService,
  'createAgentSession' | 'deleteAgentSession' | 'updateAgentSession'
>;
type SessionDomainService = Pick<
  typeof sessionDomainService,
  'clearSession' | 'getTranscriptSnapshot'
>;
type SessionLifecycleService = Pick<typeof sessionLifecycleService, 'startSession' | 'stopSession'>;
type WorkspaceAutoIterationService = Pick<
  typeof workspaceAutoIterationService,
  'getExecutionContext' | 'setSession' | 'finishSessionIfMatching'
>;
type AutoIterationRollbackReason =
  | 'auto_iteration_startup_failed_after_create'
  | 'auto_iteration_recycle_failed_after_create';

/** Only the capabilities used by auto-iteration session handoff and its compensation. */
export interface AutoIterationSessionPorts {
  sessionDataService: SessionDataService;
  sessionDomainService: SessionDomainService;
  sessionLifecycleService: SessionLifecycleService;
  sessionService: Pick<typeof sessionService, 'sendAcpMessage'>;
  workspaceAutoIterationService: WorkspaceAutoIterationService;
}

async function stopSessionBestEffort(
  sessionLifecycleService: SessionLifecycleService,
  sessionId: string
): Promise<void> {
  try {
    await sessionLifecycleService.stopSession(sessionId, { recordLifecycleEvent: false });
  } catch {
    // Best-effort cleanup
  }
}

async function stopPreviousAutoIterationSession(
  sessionLifecycleService: SessionLifecycleService,
  sessionId: string
): Promise<void> {
  try {
    await sessionLifecycleService.stopSession(sessionId);
  } catch (error) {
    if (!(error instanceof Error && /already stopped|not found/i.test(error.message))) {
      throw error;
    }
    // Session may already be stopped
  }
}

async function finishFailedAutoIterationSessionIfMatching(
  workspaceAutoIterationService: WorkspaceAutoIterationService,
  workspaceId: string,
  sessionId: string
): Promise<boolean> {
  try {
    return await workspaceAutoIterationService.finishSessionIfMatching(
      workspaceId,
      sessionId,
      AutoIterationStatus.FAILED
    );
  } catch {
    // Preserve the original handoff or persistence error
    return false;
  }
}

async function rollbackCreatedAutoIterationSession(
  sessionLifecycleService: SessionLifecycleService,
  sessionDataService: SessionDataService,
  sessionDomainService: SessionDomainService,
  sessionId: string,
  rollbackReason: AutoIterationRollbackReason
): Promise<void> {
  await stopSessionBestEffort(sessionLifecycleService, sessionId);

  try {
    sessionDomainService.clearSession(sessionId);
  } catch {
    // Preserve the original startup or handoff error
  }

  try {
    await sessionDataService.deleteAgentSession(sessionId);
  } catch {
    try {
      await sessionDataService.updateAgentSession(sessionId, {
        status: SessionStatus.FAILED,
        providerProcessPid: null,
        providerMetadata: {
          rollbackReason,
        },
      });
    } catch {
      // Preserve the original startup or handoff error
    }
  }
}

async function retireStoppedAutoIterationSession(
  sessionDataService: SessionDataService,
  sessionId: string
): Promise<void> {
  await sessionDataService.updateAgentSession(sessionId, {
    status: SessionStatus.COMPLETED,
    providerProcessPid: null,
  });
}

async function retireStoppedAutoIterationSessionBestEffort(
  sessionDataService: SessionDataService,
  sessionId: string
): Promise<void> {
  try {
    await retireStoppedAutoIterationSession(sessionDataService, sessionId);
  } catch {
    // Retirement bookkeeping must not invalidate a failed cleanup or successful handoff
  }
}

async function finishFailedRecycleIfSessionMatches(
  workspaceAutoIterationService: WorkspaceAutoIterationService,
  workspaceId: string,
  previousSessionId: string | undefined,
  replacementSessionId: string | undefined
): Promise<void> {
  if (
    replacementSessionId &&
    (await finishFailedAutoIterationSessionIfMatching(
      workspaceAutoIterationService,
      workspaceId,
      replacementSessionId
    ))
  ) {
    return;
  }
  if (previousSessionId && previousSessionId !== replacementSessionId) {
    await finishFailedAutoIterationSessionIfMatching(
      workspaceAutoIterationService,
      workspaceId,
      previousSessionId
    );
  }
}

async function cleanupFailedAutoIterationRecycle(
  sessionLifecycleService: SessionLifecycleService,
  sessionDataService: SessionDataService,
  sessionDomainService: SessionDomainService,
  workspaceAutoIterationService: WorkspaceAutoIterationService,
  workspaceId: string,
  previousSessionId: string | undefined,
  replacementSessionId?: string
): Promise<void> {
  await finishFailedRecycleIfSessionMatches(
    workspaceAutoIterationService,
    workspaceId,
    previousSessionId,
    replacementSessionId
  );
  if (replacementSessionId) {
    await rollbackCreatedAutoIterationSession(
      sessionLifecycleService,
      sessionDataService,
      sessionDomainService,
      replacementSessionId,
      'auto_iteration_recycle_failed_after_create'
    );
  }
  if (previousSessionId) {
    await retireStoppedAutoIterationSessionBestEffort(sessionDataService, previousSessionId);
  }
}

/** Own auto-iteration session workflow while leaving runtime and durable writes in their services. */
export function createAutoIterationSessionBridge(
  ports: AutoIterationSessionPorts
): AutoIterationSessionBridge {
  const {
    sessionDataService,
    sessionDomainService,
    sessionLifecycleService,
    sessionService,
    workspaceAutoIterationService,
  } = ports;
  return {
    async startSession(workspaceId, opts) {
      const session = await sessionDataService.createAgentSession({
        workspaceId,
        name: 'Auto-iteration',
        workflow: 'auto-iteration',
      });
      try {
        await sessionLifecycleService.startSession(session.id, {
          initialPrompt: opts.initialPrompt,
          startupModePreset: opts.startupModePreset,
        });
      } catch (err) {
        await rollbackCreatedAutoIterationSession(
          sessionLifecycleService,
          sessionDataService,
          sessionDomainService,
          session.id,
          'auto_iteration_startup_failed_after_create'
        );
        throw err;
      }
      return session.id;
    },
    async sendPrompt(sessionId, prompt, timeoutMs) {
      await sessionService.sendAcpMessage(sessionId, [{ type: 'text', text: prompt }], timeoutMs, {
        timeoutKind: 'configured',
      });
    },
    async waitForIdle(_sessionId) {
      // sendAcpMessage already blocks until the turn completes
    },
    async stopSession(sessionId) {
      await sessionLifecycleService.stopSession(sessionId);
    },
    getLastAssistantMessage(sessionId): Promise<string> {
      const transcript = sessionDomainService.getTranscriptSnapshot(sessionId);
      for (let i = transcript.length - 1; i >= 0; i--) {
        const entry = transcript[i];
        // AgentMessage.type === 'assistant' identifies assistant turns
        // AgentMessage.message.content is AgentContentItem[] | string
        if (entry?.message?.type === 'assistant') {
          const content = entry.message.message?.content;
          if (typeof content === 'string') {
            return Promise.resolve(content);
          }
          if (Array.isArray(content)) {
            return Promise.resolve(
              content
                .filter(
                  (b) => typeof b === 'object' && b !== null && 'type' in b && b.type === 'text'
                )
                .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
                .join('')
            );
          }
          return Promise.resolve('');
        }
      }
      return Promise.resolve('');
    },
    async recycleSession(workspaceId, handoffPrompt) {
      const ws = await workspaceAutoIterationService.getExecutionContext(workspaceId);
      const previousSessionId = ws?.autoIterationSessionId ?? undefined;
      if (previousSessionId) {
        await stopPreviousAutoIterationSession(sessionLifecycleService, previousSessionId);
      }
      let newSession: Awaited<ReturnType<SessionDataService['createAgentSession']>>;
      try {
        newSession = await sessionDataService.createAgentSession({
          workspaceId,
          name: 'Auto-iteration (recycled)',
          workflow: 'auto-iteration',
        });
      } catch (err) {
        await cleanupFailedAutoIterationRecycle(
          sessionLifecycleService,
          sessionDataService,
          sessionDomainService,
          workspaceAutoIterationService,
          workspaceId,
          previousSessionId
        );
        throw err;
      }
      try {
        await sessionLifecycleService.startSession(newSession.id, {
          startupModePreset: 'non_interactive',
        });
      } catch (err) {
        await cleanupFailedAutoIterationRecycle(
          sessionLifecycleService,
          sessionDataService,
          sessionDomainService,
          workspaceAutoIterationService,
          workspaceId,
          previousSessionId,
          newSession.id
        );
        throw err;
      }
      try {
        await workspaceAutoIterationService.setSession(workspaceId, newSession.id);
        await sessionService.sendAcpMessage(newSession.id, [{ type: 'text', text: handoffPrompt }]);
        if (previousSessionId) {
          await retireStoppedAutoIterationSessionBestEffort(sessionDataService, previousSessionId);
        }
      } catch (err) {
        await cleanupFailedAutoIterationRecycle(
          sessionLifecycleService,
          sessionDataService,
          sessionDomainService,
          workspaceAutoIterationService,
          workspaceId,
          previousSessionId,
          newSession.id
        );
        throw err;
      }
      return newSession.id;
    },
  };
}
