import { createLogger } from '@/backend/services/logger.service';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { AcpEventProcessor } from './acp-event-processor';
import type { SessionLifecycleGate } from './session-lifecycle-gate';
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
