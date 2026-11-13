// Process listing, process identity and process-group shutdown.
//
// A process is identified by its pid and its start time (`ps -o lstart`), the
// way src/backend/lib/worktree-process-sweep.ts does: a pid whose start time
// changed has exited and its number may belong to someone else. Nothing here
// signals a pid without first matching both.
import { execFileSync } from 'node:child_process';

/** Parses `ps -A -o pid=,ppid=,pgid=,stat=,lstart=`; the start time is compared only for equality. */
export function parseProcessTable(output) {
  const processes = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line);
    if (match) {
      processes.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        zombie: match[4].startsWith('Z'),
        startedAt: match[5],
      });
    }
  }
  return processes;
}

/** The live (not zombie) process with this pid, or null. */
export function findProcess(processes, pid) {
  return processes.find((process) => process.pid === pid && !process.zombie) ?? null;
}

/** True when `identity.pid` is live and started at `identity.startedAt`. */
export function isSameProcess(processes, identity) {
  return (
    Boolean(identity?.startedAt) &&
    findProcess(processes, identity.pid)?.startedAt === identity.startedAt
  );
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

/**
 * @typedef {{ pid: number, ppid: number, pgid: number, zombie: boolean, startedAt: string }} ProcessEntry
 * @typedef {object} ProcessSystem
 * @property {() => ProcessEntry[]} listProcesses
 * @property {(target: number, signal: string) => void} signal
 * @property {(ms: number) => Promise<unknown>} sleep
 * @property {() => number} now
 */

/** @type {ProcessSystem} */
export const realSystem = {
  listProcesses: () =>
    parseProcessTable(
      execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='], {
        encoding: 'utf8',
        // A fixed locale keeps `lstart` comparable between launcher and `--clean`.
        env: { ...process.env, LC_ALL: 'C' },
      })
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
};

/** This process's own start time, for sandbox.json. */
export function ownIdentity(system = realSystem) {
  const self = findProcess(system.listProcesses(), process.pid);
  if (!self) {
    throw new Error('Cannot read this process in the process table.');
  }
  return { pid: self.pid, startedAt: self.startedAt };
}

/**
 * Whether group `pgid`, whose leader started at `leaderStartedAt`, is still the
 * same group. A group ID is not reused while any member lives, and it is the
 * leader's pid; so when a live process holds that pid with another start time,
 * the recorded group is gone and that number belongs to someone else.
 */
export function isOwnGroup(processes, pgid, leaderStartedAt) {
  const holder = findProcess(processes, pgid);
  return holder === null || holder.startedAt === leaderStartedAt;
}

/**
 * Stops every process in `pgid` and its descendants: SIGTERM, then SIGKILL
 * after `graceMs`. Each process is tracked by pid and start time from the first
 * listing (and from later listings, for processes the group starts meanwhile);
 * only those still matching are signalled or waited for. Resolves with
 * `{ owned: false }` without signalling when the group is no longer the one
 * recorded; otherwise once none is left; rejects if any survives SIGKILL.
 *
 * @param {number} pgid
 * @param {{ system?: ProcessSystem, leaderStartedAt?: string | null, graceMs?: number, killGraceMs?: number, pollMs?: number }} [options]
 * @returns {Promise<{ owned: boolean }>}
 */
export async function stopProcessGroup(
  pgid,
  { system = realSystem, leaderStartedAt, graceMs = 15_000, killGraceMs = 5000, pollMs = 200 } = {}
) {
  if (!leaderStartedAt) {
    throw new Error(`No start time recorded for process group ${pgid}.`);
  }
  const tracked = new Map();
  let groupOwned = true;
  const remaining = () => {
    const processes = system.listProcesses();
    groupOwned &&= isOwnGroup(processes, pgid, leaderStartedAt);
    const byPid = new Map(processes.filter((p) => !p.zombie).map((p) => [p.pid, p]));
    for (const [pid, startedAt] of tracked) {
      if (byPid.get(pid)?.startedAt !== startedAt) {
        tracked.delete(pid);
      }
    }
    if (groupOwned) {
      for (const pid of collectGroupProcesses(processes, pgid)) {
        const entry = byPid.get(pid);
        // A newcomer joins only through the group or a tracked parent.
        if (!tracked.has(pid) && entry && (entry.pgid === pgid || tracked.has(entry.ppid))) {
          tracked.set(pid, entry.startedAt);
        }
      }
    }
    return [...tracked.keys()];
  };
  const signalAll = (signal) => {
    remaining();
    if (groupOwned) {
      system.signal(-pgid, signal);
    }
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
    return { owned: groupOwned };
  }
  signalAll('SIGTERM');
  if (await waitForExit(graceMs)) {
    return { owned: true };
  }
  signalAll('SIGKILL');
  if (!(await waitForExit(killGraceMs))) {
    throw new Error(`Processes still running after SIGKILL: ${remaining().join(', ')}`);
  }
  return { owned: true };
}
