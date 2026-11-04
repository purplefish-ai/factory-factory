import type { ChildProcess } from 'node:child_process';

/** Activation may start only after the backend has actually terminated. */
export function stopBackendForUpdate(child: ChildProcess, timeoutMs = 120_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let terminated = child.exitCode !== null || child.signalCode !== null;
    const cleanup = () => {
      clearTimeout(deadline);
      child.off('exit', exited);
      child.off('close', exited);
      child.off('error', failed);
    };
    const exited = (code: number | null) => {
      terminated = true;
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Backend shutdown failed (${code}). No update was activated.`));
      }
    };
    const failed = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const deadline = setTimeout(() => {
      if (!terminated && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.once('exit', exited);
    child.once('close', exited);
    child.once('error', failed);
    if (terminated) {
      exited(child.exitCode);
      return;
    }
    if (!child.kill('SIGTERM')) {
      failed(new Error('Could not request graceful backend shutdown.'));
    }
  });
}
