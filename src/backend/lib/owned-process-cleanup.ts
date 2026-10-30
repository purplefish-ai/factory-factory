import { type ChildProcess, execFile } from 'node:child_process';

function signalOwnedGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw new Error('Disposable process cleanup failed');
  }
}

async function terminateDirectProcess(
  child: ChildProcess,
  timeoutMs: number,
  initialSignal: 'SIGINT' | 'SIGTERM'
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onExit!: () => void;
  const exited = new Promise<boolean>((resolve) => {
    onExit = () => resolve(true);
    child.once('exit', onExit);
    child.once('close', onExit);
  });
  try {
    child.kill(initialSignal);
    if (
      !(await Promise.race([
        exited,
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]))
    ) {
      child.kill('SIGKILL');
    }
  } finally {
    clearTimeout(timeout);
    child.removeListener('exit', onExit);
    child.removeListener('close', onExit);
  }
}

export async function terminateDisposableProcessTree(
  child: ChildProcess,
  options: { timeoutMs?: number; initialSignal?: 'SIGINT' | 'SIGTERM' } = {}
): Promise<void> {
  const timeoutMs = Math.max(0, Math.min(5000, options.timeoutMs ?? 5000));
  const { initialSignal = 'SIGTERM' } = options;
  const startedAt = Date.now();
  const pid = child.pid;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    await terminateDirectProcess(child, timeoutMs, initialSignal);
    return;
  }
  if (process.platform === 'win32') {
    const hasExited = () => child.exitCode !== null || child.signalCode !== null;
    await new Promise<void>((resolve, reject) => {
      let taskkillCompleted = false;
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        child.removeListener('exit', onExit);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const onExit = () => {
        if (taskkillCompleted) {
          finish();
        }
      };
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error('Disposable process cleanup failed'));
      }, timeoutMs);
      child.once('exit', onExit);
      execFile(
        'taskkill',
        ['/PID', String(pid), '/T', '/F'],
        { timeout: Math.max(1, Math.min(4000, Math.floor(timeoutMs * 0.8))), windowsHide: true },
        (error) => {
          taskkillCompleted = true;
          if (hasExited()) {
            finish();
          } else if (error) {
            // Native probes own codex.exe directly, so this fallback still owns
            // the app-server even when taskkill is unavailable or fails.
            child.kill('SIGKILL');
          }
        }
      );
    });
    return;
  }
  // The launcher may exit before its native app-server descendants or inherited pipes.
  // Its detached process group remains ours until every descendant has exited.
  const deadline = startedAt + timeoutMs * 0.8;
  if (!signalOwnedGroup(pid, initialSignal)) {
    return;
  }
  while (signalOwnedGroup(pid, 0)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      signalOwnedGroup(pid, 'SIGKILL');
      const killDeadline = startedAt + timeoutMs;
      while (signalOwnedGroup(pid, 0)) {
        if (Date.now() >= killDeadline) {
          throw new Error('Disposable process cleanup failed');
        }
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(20, Math.max(0, killDeadline - Date.now())))
        );
      }
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remaining)));
  }
}
