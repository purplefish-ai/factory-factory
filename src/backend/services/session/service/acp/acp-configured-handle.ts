import type { AcpProcessHandle } from './acp-process-handle';
import type { AcpRuntimeManager } from './acp-runtime-manager';

/** Run a public mutation only after the captured active incarnation is configured. */
export async function withConfiguredAcpHandle<T>(
  runtime: Pick<AcpRuntimeManager, 'getClient' | 'isStopInProgress'>,
  sessionId: string,
  handle: AcpProcessHandle,
  operation: () => Promise<T>
): Promise<T> {
  while (handle.configurationReady !== undefined) {
    await handle.configurationReady;
  }
  if (runtime.getClient(sessionId) !== handle || runtime.isStopInProgress(sessionId)) {
    throw new Error('Session runtime changed before configuration update');
  }
  const result = await operation();
  if (runtime.getClient(sessionId) !== handle || runtime.isStopInProgress(sessionId)) {
    throw new Error('Session runtime changed during configuration update');
  }
  return result;
}
