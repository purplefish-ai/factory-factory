import { execFileSync } from 'node:child_process';

function isZombieProcess(pid: number): boolean {
  if (process.platform === 'win32') {
    return false;
  }

  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return state.startsWith('Z');
  } catch {
    // A failed state lookup is not enough evidence to declare an existing PID dead.
    return false;
  }
}

/** Return whether a PID names a live, non-zombie process, including inaccessible processes. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !isZombieProcess(pid);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
