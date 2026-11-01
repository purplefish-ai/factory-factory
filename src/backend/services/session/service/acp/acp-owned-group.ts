import type { AcpProcessHandle } from './acp-process-handle';

/** Proves only disappearance of the currently owned local group, never external effects. */
export async function stopOwnedRuntimeGroup(
  handle: Pick<AcpProcessHandle, 'child' | 'ownedProcessGroup'>,
  options: {
    signal?: (pid: number, signal: NodeJS.Signals | 0) => unknown;
    platform?: NodeJS.Platform;
    timeoutMs?: number;
    assertOwned?: () => void;
  } = {}
): Promise<'LOCAL_RUNTIME_GROUP_STOPPED' | 'UNKNOWN'> {
  const pid = handle.ownedProcessGroup;
  if (
    (options.platform ?? process.platform) === 'win32' ||
    !pid ||
    pid <= 1 ||
    pid !== handle.child.pid
  ) {
    return 'UNKNOWN';
  }
  const signal = options.signal ?? ((target, value) => process.kill(target, value));
  const probe = () => {
    options.assertOwned?.();
    try {
      signal(-pid, 0);
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        return false;
      }
      throw error;
    }
  };
  const timeout = Math.max(1, Math.min(options.timeoutMs ?? 5000, 10_000));
  const deadline = Date.now() + timeout;
  try {
    if (!probe()) {
      return 'LOCAL_RUNTIME_GROUP_STOPPED';
    }
    options.assertOwned?.();
    signal(-pid, 'SIGTERM');
    let escalated = false;
    while (probe()) {
      if (Date.now() >= deadline) {
        return 'UNKNOWN';
      }
      if (!escalated && Date.now() >= deadline - timeout / 2) {
        options.assertOwned?.();
        signal(-pid, 'SIGKILL');
        escalated = true;
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now())))
      );
    }
    return 'LOCAL_RUNTIME_GROUP_STOPPED';
  } catch {
    return 'UNKNOWN';
  }
}
