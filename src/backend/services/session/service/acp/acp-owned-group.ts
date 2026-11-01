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
  const groupPid = ownedGroupPid(handle, options.platform ?? process.platform);
  if (!groupPid) {
    return 'UNKNOWN';
  }
  const signal = options.signal ?? ((target, value) => process.kill(target, value));
  const probe = () => {
    options.assertOwned?.();
    try {
      signal(-groupPid, 0);
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
    signal(-groupPid, 'SIGTERM');
    let escalated = false;
    while (probe()) {
      if (!escalated && Date.now() >= deadline - timeout / 2) {
        options.assertOwned?.();
        signal(-groupPid, 'SIGKILL');
        escalated = true;
      }
      if (Date.now() >= deadline) {
        return probe() ? 'UNKNOWN' : 'LOCAL_RUNTIME_GROUP_STOPPED';
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

function ownedGroupPid(
  handle: Pick<AcpProcessHandle, 'child' | 'ownedProcessGroup'>,
  platform: NodeJS.Platform
): number | undefined {
  const pid = handle.ownedProcessGroup;
  return platform !== 'win32' && pid !== undefined && pid > 1 && pid === handle.child.pid
    ? pid
    : undefined;
}
