import { createLogger } from '@/backend/services/logger.service';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { AcpEventProcessor } from './acp-event-processor';
import { requestsStartupCleanup } from './event-session-startup';
import type { SessionLifecycleGate } from './session-lifecycle-gate';
import type { StartSessionOptions } from './session-startup-options';
import type { StopSessionOptions } from './session-termination.coordinator';
import { toErrorMessage } from './session.error-message';

const logger = createLogger('session');

type StartupFailureDependencies = {
  runtimeManager: Pick<AcpRuntimeManager, 'getClient' | 'stopClient'>;
  lifecycleGate: SessionLifecycleGate;
  sessionDomainService: Pick<SessionDomainService, 'setRuntimeSnapshot'>;
  acpEventProcessor: Pick<AcpEventProcessor, 'clearSessionState'>;
  canUpdateState: (generation?: number) => boolean;
};

/** Same candidate configuration failure stops that incarnation, including shared candidates. */
export async function stopStartupConfigurationFailure(
  sessionId: string,
  handle: AcpProcessHandle,
  stopGeneration: number,
  error: unknown,
  deps: StartupFailureDependencies
): Promise<never> {
  const canUpdateFailureState = (generation?: number) => {
    const current = deps.runtimeManager.getClient(sessionId);
    return (!current || current === handle) && deps.canUpdateState(generation);
  };
  if (!canUpdateFailureState(stopGeneration)) {
    throw error;
  }
  const stopReservation = deps.lifecycleGate.reserveStop(sessionId);
  if (!stopReservation) {
    throw error;
  }
  try {
    await deps.runtimeManager.stopClient(sessionId).catch((stopError: unknown) => {
      logger.warn('Failed to stop runtime after startup configuration failure', {
        sessionId,
        error: toErrorMessage(stopError),
      });
    });
    if (
      canUpdateFailureState() &&
      deps.lifecycleGate.isGenerationCurrent(sessionId, stopReservation.generation)
    ) {
      deps.sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: 'error',
        processState: 'stopped',
        activity: 'IDLE',
        errorMessage: `Failed to start agent: ${toErrorMessage(error)}`,
        updatedAt: new Date().toISOString(),
      });
    }
  } finally {
    try {
      if (
        canUpdateFailureState() &&
        deps.lifecycleGate.isGenerationCurrent(sessionId, stopReservation.generation)
      ) {
        deps.acpEventProcessor.clearSessionState(sessionId);
      }
    } finally {
      stopReservation.release();
    }
  }
  throw error;
}

/** Request failure cleanup owns a captured candidate, never unrelated queued input. */
export async function cleanupFailedStartup(
  input: {
    sessionId: string;
    ownership: { handle?: AcpProcessHandle; shared: boolean };
    stopGeneration: number;
    options?: StartSessionOptions;
    error: unknown;
  },
  deps: StartupFailureDependencies & {
    runtimeManager: Pick<
      AcpRuntimeManager,
      'getClient' | 'stopClient' | 'hasClientCreationOperation'
    >;
    stopSession(sessionId: string, options?: StopSessionOptions): Promise<void>;
  }
): Promise<void> {
  const { sessionId, ownership, stopGeneration, options, error } = input;
  const current = deps.runtimeManager.getClient(sessionId);
  if (
    !(requestsStartupCleanup(options) && ownership.handle) ||
    ownership.shared ||
    deps.runtimeManager.hasClientCreationOperation(sessionId) ||
    (current && current !== ownership.handle)
  ) {
    return;
  }
  if (options?.assertCurrentSync) {
    await stopStartupConfigurationFailure(sessionId, ownership.handle, stopGeneration, error, deps);
  }
  await deps.stopSession(sessionId, {
    reason: 'SYSTEM_STOP',
    recordLifecycleEvent: false,
    cleanupTransientRatchetSession: false,
  });
}
