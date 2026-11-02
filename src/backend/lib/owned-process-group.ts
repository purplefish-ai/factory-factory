import type { ChildProcess } from 'node:child_process';
type OwnedProcessGroup = { child: ChildProcess; ownedProcessGroup?: number };

/** Proves only disappearance of the currently owned local group, never external effects. */
export async function stopOwnedProcessGroup(
  handle: OwnedProcessGroup,
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
  const probe = (allowPermissionUncertainty = false): 'PRESENT' | 'ABSENT' | 'UNCERTAIN' => {
    options.assertOwned?.();
    try {
      signal(-groupPid, 0);
      return 'PRESENT';
    } catch (error) {
      return resolveProbeError(error, allowPermissionUncertainty);
    }
  };
  const timeout = Math.max(1, Math.min(options.timeoutMs ?? 5000, 10_000));
  const deadline = Date.now() + timeout;
  try {
    if (probe() === 'ABSENT') {
      return 'LOCAL_RUNTIME_GROUP_STOPPED';
    }
    options.assertOwned?.();
    signal(-groupPid, 'SIGTERM');
    return await waitForGroupDisappearance(
      probe,
      () => {
        options.assertOwned?.();
        signal(-groupPid, 'SIGKILL');
      },
      deadline,
      timeout
    );
  } catch {
    return 'UNKNOWN';
  }
}

function ownedGroupPid(handle: OwnedProcessGroup, platform: NodeJS.Platform): number | undefined {
  const pid = handle.ownedProcessGroup;
  return platform !== 'win32' && pid !== undefined && pid > 1 && pid === handle.child.pid
    ? pid
    : undefined;
}

function resolveProbeError(
  error: unknown,
  allowPermissionUncertainty: boolean
): 'ABSENT' | 'UNCERTAIN' {
  if (error instanceof Error && 'code' in error) {
    if (error.code === 'ESRCH') {
      return 'ABSENT';
    }
    if (allowPermissionUncertainty && error.code === 'EPERM') {
      return 'UNCERTAIN';
    }
  }
  throw error;
}

async function waitForGroupDisappearance(
  probe: (allowPermissionUncertainty: boolean) => 'PRESENT' | 'ABSENT' | 'UNCERTAIN',
  escalate: () => void,
  deadline: number,
  timeout: number
): Promise<'LOCAL_RUNTIME_GROUP_STOPPED' | 'UNKNOWN'> {
  let escalated = false;
  while (true) {
    // A post-signal EPERM is uncertainty, never disappearance or permission to escalate.
    const state = probe(true);
    if (state === 'ABSENT') {
      return 'LOCAL_RUNTIME_GROUP_STOPPED';
    }
    if (state === 'PRESENT' && !escalated && Date.now() >= deadline - timeout / 2) {
      escalate();
      escalated = true;
    }
    if (Date.now() >= deadline) {
      return probe(true) === 'ABSENT' ? 'LOCAL_RUNTIME_GROUP_STOPPED' : 'UNKNOWN';
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now())))
    );
  }
}
