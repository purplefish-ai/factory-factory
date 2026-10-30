import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function isZombieProcess(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    return false;
  }

  try {
    // Async so recovery sweeps over many PIDs don't block the event loop on `ps`.
    const { stdout } = await execFileAsync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    return stdout.trim().startsWith('Z');
  } catch {
    // A failed state lookup is not enough evidence to declare an existing PID dead.
    return false;
  }
}

/** Return whether a PID names a live, non-zombie process, including inaccessible processes. */
export async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  return !(await isZombieProcess(pid));
}
