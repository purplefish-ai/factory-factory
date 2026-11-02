import type { AcpProcessHandle } from './acp-process-handle';
import type { AcpRuntimeManager } from './acp-runtime-manager';

/** Run a public mutation only after the captured active incarnation is configured. */
export async function withConfiguredAcpHandle<T>(
  runtime: Pick<AcpRuntimeManager, 'getClient' | 'isStopInProgress'>,
  sessionId: string,
  handle: AcpProcessHandle,
  operation: () => Promise<T>,
  guard?: { check(): Promise<void>; assertCurrent(): void }
): Promise<T> {
  while (handle.configurationReady !== undefined) {
    await handle.configurationReady;
  }
  assertConfiguredAcpHandle(runtime, sessionId, handle);
  if (guard) {
    await guard.check();
    assertConfiguredAcpHandle(runtime, sessionId, handle);
    guard.assertCurrent();
  }
  const result = await operation();
  if (runtime.getClient(sessionId) !== handle || runtime.isStopInProgress(sessionId)) {
    throw new Error('Session runtime changed during configuration update');
  }
  return result;
}

export function assertConfiguredAcpHandle(
  runtime: Pick<AcpRuntimeManager, 'getClient' | 'isStopInProgress'>,
  sessionId: string,
  handle: AcpProcessHandle
): void {
  if (
    runtime.getClient(sessionId) !== handle ||
    runtime.isStopInProgress(sessionId) ||
    handle.configurationReady !== undefined
  ) {
    throw new Error('Session runtime changed before configuration update');
  }
}
