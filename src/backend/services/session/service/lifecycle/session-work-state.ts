import type { AcpProcessHandle } from '@/backend/services/session/service/acp/acp-process-handle';
import type { SessionRuntimeState } from '@/shared/session-runtime';

/** Read current work when publishing runtime state, including after prompt completion. */
export function getAcpWorkState(
  handle: AcpProcessHandle | null | undefined,
  promptInFlight = handle?.isPromptInFlight
): Pick<SessionRuntimeState, 'work'> {
  if (!handle?.nativeSessionTracker) {
    return {};
  }
  return {
    work: {
      promptInFlight: Boolean(promptInFlight),
      controlRuntimeId: handle.nativeSessionTracker.getControlRuntimeId(),
      ...handle.nativeSessionTracker.getBackgroundWork(),
    },
  };
}
