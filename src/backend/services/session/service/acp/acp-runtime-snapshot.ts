import type { AcpProcessHandle } from './acp-process-handle';
import type { AcpActiveProcessSnapshot } from './acp-runtime-contracts';

export function activeProcessSnapshots(
  sessions: ReadonlyMap<string, AcpProcessHandle>
): AcpActiveProcessSnapshot[] {
  return [...sessions].map(([sessionId, handle]) => {
    const isRunning = handle.isRunning();
    return {
      sessionId,
      pid: handle.getPid(),
      status: isRunning ? 'running' : 'stopped',
      isRunning,
      isPromptInFlight: handle.isPromptInFlight,
      provider: handle.provider,
    };
  });
}
