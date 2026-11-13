// Process listing and process-group shutdown.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Parses `ps -A -o pid=,ppid=,pgid=,stat=`. */
export function parseProcessTable(output) {
  const processes = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (match) {
      processes.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        zombie: match[4].startsWith('Z'),
      });
    }
  }
  return processes;
}

/**
 * Live processes in the group plus their descendants, which can leave the
 * group (provider adapters run in their own process groups).
 */
export function collectGroupProcesses(processes, pgid) {
  const live = processes.filter((process) => !process.zombie);
  const found = new Set(live.filter((process) => process.pgid === pgid).map((p) => p.pid));
  let grew = true;
  while (grew) {
    grew = false;
    for (const process of live) {
      if (!found.has(process.pid) && found.has(process.ppid)) {
        found.add(process.pid);
        grew = true;
      }
    }
  }
  return found;
}

export const realSystem = {
  listProcesses: () =>
    parseProcessTable(
      execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' })
    ),
  signal: (target, signal) => {
    try {
      process.kill(target, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw error;
      }
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  /** A live process's environment as text: NUL-separated on Linux, `ps -E` on macOS. */
  readEnvironment: (pid) => {
    try {
      return process.platform === 'linux'
        ? readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').join('\n')
        : execFileSync('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], {
            encoding: 'utf8',
          })
            .split(/\s+/)
            .join('\n');
    } catch {
      return '';
    }
  },
};

/**
 * True when a process of `pgid` (or a descendant) runs with this sandbox's
 * `BASE_DIR`, so a process group whose ID was reused is never signalled.
 */
export function isSandboxProcessGroup(pgid, baseDir, system = realSystem) {
  return [...collectGroupProcesses(system.listProcesses(), pgid)].some((pid) =>
    system.readEnvironment(pid).split('\n').includes(`BASE_DIR=${baseDir}`)
  );
}

export function isProcessRunning(pid, system = realSystem) {
  return system.listProcesses().some((process) => process.pid === pid && !process.zombie);
}

/**
 * Stops every process in `pgid` and its descendants: SIGTERM, then SIGKILL
 * after `graceMs`. Resolves only once none is left; rejects if any survives.
 */
export async function stopProcessGroup(
  pgid,
  { system = realSystem, graceMs = 15_000, killGraceMs = 5000, pollMs = 200 } = {}
) {
  const tracked = collectGroupProcesses(system.listProcesses(), pgid);
  const remaining = () => {
    const processes = system.listProcesses();
    for (const pid of collectGroupProcesses(processes, pgid)) {
      tracked.add(pid);
    }
    const live = new Set(processes.filter((p) => !p.zombie).map((p) => p.pid));
    return [...tracked].filter((pid) => live.has(pid));
  };
  const signalAll = (signal) => {
    system.signal(-pgid, signal);
    for (const pid of remaining()) {
      system.signal(pid, signal);
    }
  };
  const waitForExit = async (timeoutMs) => {
    const deadline = system.now() + timeoutMs;
    while (remaining().length > 0) {
      if (system.now() >= deadline) {
        return false;
      }
      await system.sleep(pollMs);
    }
    return true;
  };
  if (remaining().length === 0) {
    return;
  }
  signalAll('SIGTERM');
  if (await waitForExit(graceMs)) {
    return;
  }
  signalAll('SIGKILL');
  if (!(await waitForExit(killGraceMs))) {
    throw new Error(`Processes still running after SIGKILL: ${remaining().join(', ')}`);
  }
}
