import type { SessionRuntimeState } from '@/shared/session-runtime';
import type { AcpProcessHandle } from '../acp/acp-process-handle';

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
      ...handle.nativeSessionTracker.getBackgroundWork(),
    },
  };
}
