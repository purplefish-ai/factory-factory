import { type ChildProcess, execFile } from 'node:child_process';
import { terminateCatalogProcess } from './acp-runtime-spawn';

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

export async function terminateDisposableProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    await terminateCatalogProcess(child);
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
      }, 5000);
      child.once('exit', onExit);
      execFile(
        'taskkill',
        ['/PID', String(pid), '/T', '/F'],
        { timeout: 4000, windowsHide: true },
        (error) => {
          taskkillCompleted = true;
          if (hasExited()) {
            finish();
          } else if (error) {
            // Quota probes own codex.exe directly, so this fallback still owns
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
  const deadline = Date.now() + 5000;
  if (!signalOwnedGroup(pid, 'SIGTERM')) {
    return;
  }
  while (signalOwnedGroup(pid, 0)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      signalOwnedGroup(pid, 'SIGKILL');
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remaining)));
  }
}
