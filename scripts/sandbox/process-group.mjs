// Process listing, process identity and process-group shutdown.
//
// A process is identified by its pid and its start time (`ps -o lstart`), the
// way src/backend/lib/worktree-process-sweep.ts does: a pid whose start time
// changed has exited and its number may belong to someone else. Nothing here
// signals a pid without first matching both. A process group is a sandbox's
// only while its recorded leader lives, or while a member runs with the
// sandbox's BASE_DIR; group numbers are reused too.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

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
 * @property {(entry: string, pids: number[] | null) => number[]} processesWithEnvironment
 *   Those of `pids` (every process when null) whose environment holds `entry`
 *   (`NAME=value`) exactly.
 */

/** Environment matching for the real process table: /proc on Linux, `ps -E` on macOS. */
function processesWithEnvironment(entry, pids) {
  if (process.platform === 'linux') {
    const candidates =
      pids ??
      readdirSync('/proc')
        .filter((name) => /^\d+$/.test(name))
        .map(Number);
    return candidates.filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(entry);
      } catch {
        return false;
      }
    });
  }
  if (pids?.length === 0) {
    return [];
  }
  // `ps -E` appends the environment to the command, space-separated, one line
  // per process (a newline in a value is printed as \012). An entry matches
  // between spaces, so a value with spaces still matches whole.
  const output = execFileSync(
    'ps',
    ['-E', '-ww', '-o', 'pid=,command=', ...(pids ? ['-p', pids.join(',')] : ['-A'])],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }
  );
  const found = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+) (.*)$/.exec(line);
    if (match && ` ${match[2]} `.includes(` ${entry} `)) {
      found.push(Number(match[1]));
    }
  }
  return found;
}

/** @type {ProcessSystem} */
export const realSystem = {
  listProcesses: () =>
    parseProcessTable(
      execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='], {
        encoding: 'utf8',
        // `lstart` is local time in the locale's format: fix both, so the same
        // process reads the same in the launcher and in any `--clean`.
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
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
  processesWithEnvironment,
};

/** The environment entry every process of the sandbox at `baseDir` carries. */
export const sandboxEnvironmentEntry = (baseDir) => `BASE_DIR=${baseDir}`;

/** This process's own start time, for sandbox.json. */
export function ownIdentity(system = realSystem) {
  const self = findProcess(system.listProcesses(), process.pid);
  if (!self) {
    throw new Error('Cannot read this process in the process table.');
  }
  return { pid: self.pid, startedAt: self.startedAt };
}

/**
 * Whether the live group `pgid` is this sandbox's: its recorded leader is alive
 * with its recorded start time, or a live member runs with the sandbox's
 * BASE_DIR. Otherwise the number belongs to someone else (a group ID is reused
 * once its last member exits, and a stranger's leader can exit before its
 * members), and nothing in it may be signalled.
 *
 * @param {ProcessEntry[]} processes
 * @param {number} pgid
 * @param {{ leaderStartedAt?: string | null, baseDir?: string | null }} identity
 * @param {Pick<ProcessSystem, 'processesWithEnvironment'>} system
 */
export function isOwnGroup(processes, pgid, { leaderStartedAt, baseDir }, system) {
  if (leaderStartedAt && isSameProcess(processes, { pid: pgid, startedAt: leaderStartedAt })) {
    return true;
  }
  const members = processes.filter((p) => p.pgid === pgid && !p.zombie).map((p) => p.pid);
  return (
    Boolean(baseDir) &&
    members.length > 0 &&
    system.processesWithEnvironment(sandboxEnvironmentEntry(baseDir), members).length > 0
  );
}

/**
 * Stops every process in `pgid` and its descendants: SIGTERM, then SIGKILL
 * after `graceMs`. Ownership is `isOwnGroup` (the leader's start time, or
 * `baseDir` in a member's environment), checked on every listing while the
 * group has live members; once the group is someone else's it stays so. Each
 * process is tracked by pid and start time from the first listing (and from
 * later listings, for processes the group starts meanwhile); only those still
 * matching are signalled or waited for. Resolves with `{ owned: false }`
 * without signalling when the live group is not this sandbox's; otherwise once
 * none is left; rejects if any survives SIGKILL.
 *
 * @param {number} pgid
 * @param {{ system?: ProcessSystem, leaderStartedAt?: string | null, baseDir?: string | null, graceMs?: number, killGraceMs?: number, pollMs?: number }} [options]
 * @returns {Promise<{ owned: boolean }>}
 */
export async function stopProcessGroup(
  pgid,
  {
    system = realSystem,
    leaderStartedAt = null,
    baseDir = null,
    graceMs = 15_000,
    killGraceMs = 5000,
    pollMs = 200,
  } = {}
) {
  if (!leaderStartedAt && !baseDir) {
    throw new Error(`Nothing identifies process group ${pgid} as this sandbox's.`);
  }
  const tracked = new Map();
  let groupOwned = true;
  const remaining = () => {
    const processes = system.listProcesses();
    if (processes.some((p) => p.pgid === pgid && !p.zombie)) {
      groupOwned &&= isOwnGroup(processes, pgid, { leaderStartedAt, baseDir }, system);
    }
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
