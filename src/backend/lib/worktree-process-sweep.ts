import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Terminates processes left running inside a workspace worktree that no
 * Factory Factory runtime owns, such as a dev server an agent detached from a
 * background shell. A false positive kills unrelated user work, so matching is
 * deliberately narrow: see `selectWorktreeProcesses`.
 */

export interface ListedProcess {
  pid: number;
  ppid: number;
  uid: number;
  /** True when the process has a controlling terminal, or when that is unknown. */
  hasTty: boolean;
  cwd?: string;
  executable?: string;
}

export type ProcessLister = () => Promise<ListedProcess[]>;
type Signaller = (pid: number, signal: NodeJS.Signals | 0) => void;

export interface WorktreeProcessSweepOptions {
  worktreePath: string;
  worktreeBasePath: string;
  /** Defaults to the platform lister; `null` means identification is unavailable. */
  listProcesses?: ProcessLister | null;
  signal?: Signaller;
  selfPid?: number;
  selfUid?: number;
  serverCwd?: string;
  listTimeoutMs?: number;
  termGraceMs?: number;
  killGraceMs?: number;
}

export type WorktreeProcessSweepResult =
  | { status: 'unsupported' }
  | {
      status: 'swept';
      matched: number[];
      /** Exited after SIGTERM. */
      terminated: number[];
      /** Still matched after the grace period and received SIGKILL. */
      killed: number[];
      /** Could not be signalled, or had not exited by the deadline. */
      survivors: number[];
    };

const DEFAULT_LIST_TIMEOUT_MS = 4000;
const DEFAULT_TERM_GRACE_MS = 3000;
const DEFAULT_KILL_GRACE_MS = 1000;
const POLL_INTERVAL_MS = 50;
const MAX_ANCESTOR_DEPTH = 128;

function isStrictlyWithin(candidate: string, root: string): boolean {
  return candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

/** Path-boundary match: `workspace-abc` never matches `workspace-abcd`. */
export function isPathInsideRoot(candidate: string | undefined, root: string): boolean {
  if (!(candidate && path.isAbsolute(candidate))) {
    return false;
  }
  // Normalize so `root/../elsewhere` cannot pass a prefix check.
  const normalized = path.normalize(candidate);
  return normalized === root || isStrictlyWithin(normalized, root);
}

/**
 * Returns the lexical and realpath-resolved spellings of the worktree, after
 * proving each is strictly inside the matching spelling of the base directory.
 * A worktree that no longer exists keeps its real location relative to the
 * real base, so processes still reporting the removed directory can match.
 */
export async function resolveWorktreeRoots(
  worktreePath: string,
  worktreeBasePath: string
): Promise<string[]> {
  if (!(path.isAbsolute(worktreePath) && path.isAbsolute(worktreeBasePath))) {
    throw new Error('Worktree and base paths must be absolute');
  }
  const lexicalRoot = path.resolve(worktreePath);
  const lexicalBase = path.resolve(worktreeBasePath);
  if (!isStrictlyWithin(lexicalRoot, lexicalBase)) {
    throw new Error('Worktree path is outside the worktree base directory');
  }
  const realBase = await realpath(lexicalBase);
  let realRoot: string;
  try {
    if ((await lstat(lexicalRoot)).isSymbolicLink()) {
      throw new Error('Worktree path must not be a symbolic link');
    }
    realRoot = await realpath(lexicalRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    realRoot = path.join(realBase, path.relative(lexicalBase, lexicalRoot));
  }
  if (!isStrictlyWithin(realRoot, realBase)) {
    throw new Error('Worktree real path is outside the worktree base directory');
  }
  return [...new Set([lexicalRoot, realRoot])];
}

function collectAncestors(processes: ListedProcess[], selfPid: number): Set<number> {
  const parentOf = new Map(processes.map((entry) => [entry.pid, entry.ppid]));
  const protectedPids = new Set<number>([0, 1, selfPid]);
  let current = parentOf.get(selfPid);
  for (let depth = 0; current !== undefined && depth < MAX_ANCESTOR_DEPTH; depth++) {
    if (protectedPids.has(current)) {
      break;
    }
    protectedPids.add(current);
    current = parentOf.get(current);
  }
  return protectedPids;
}

/**
 * Selects processes to terminate. A process matches only when it belongs to
 * the current user, has no controlling terminal (interactive shells and
 * editors stay untouched), is not this server, one of its ancestors or PID
 * 0/1, and its working directory or executable lies inside a worktree root.
 * Command-line arguments are never matched: an IDE opened on the worktree
 * names it in its arguments without running from it.
 */
export function selectWorktreeProcesses(
  processes: ListedProcess[],
  roots: string[],
  self: { pid: number; ppid?: number; uid: number }
): number[] {
  const protectedPids = collectAncestors(processes, self.pid);
  if (self.ppid !== undefined) {
    protectedPids.add(self.ppid);
  }
  const inside = (candidate: string | undefined) =>
    roots.some((root) => isPathInsideRoot(candidate, root));
  return processes
    .filter(
      (entry) =>
        Number.isInteger(entry.pid) &&
        entry.pid > 1 &&
        !protectedPids.has(entry.pid) &&
        entry.uid === self.uid &&
        !entry.hasTty &&
        (inside(entry.cwd) || inside(entry.executable))
    )
    .map((entry) => entry.pid);
}

function execFileStdout(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        // lsof exits 1 when some selected processes vanish mid-listing; keep its output.
        const exitCode = (error as (Error & { code?: unknown }) | null)?.code;
        if (error && !(exitCode === 1 && stdout)) {
          reject(error);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/** Parses `ps -A -ww -o pid=,ppid=,uid=,tty=,comm=` output (macOS). */
export function parseDarwinPs(output: string): ListedProcess[] {
  const processes: ListedProcess[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const [, pid, ppid, uid, tty, comm] = match;
    processes.push({
      pid: Number(pid),
      ppid: Number(ppid),
      uid: Number(uid),
      hasTty: tty !== '??',
      executable: comm?.trim() || undefined,
    });
  }
  return processes;
}

/** Parses `lsof -Fpn` output into a PID to path map. */
export function parseLsofCwd(output: string): Map<number, string> {
  const cwdByPid = new Map<number, string>();
  let pid: number | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
    } else if (line.startsWith('n') && pid !== undefined && Number.isInteger(pid)) {
      cwdByPid.set(pid, line.slice(1));
    }
  }
  return cwdByPid;
}

async function listDarwinProcesses(uid: number, timeoutMs: number): Promise<ListedProcess[]> {
  const [psOutput, lsofOutput] = await Promise.all([
    execFileStdout('ps', ['-A', '-ww', '-o', 'pid=,ppid=,uid=,tty=,comm='], timeoutMs),
    execFileStdout(
      'lsof',
      ['-a', '-u', String(uid), '-d', 'cwd', '-n', '-P', '-w', '-Fpn'],
      timeoutMs
    ),
  ]);
  const cwdByPid = parseLsofCwd(lsofOutput);
  return parseDarwinPs(psOutput).map((entry) => ({ ...entry, cwd: cwdByPid.get(entry.pid) }));
}

/** Parses `/proc/<pid>/stat`; the command name may contain spaces and parentheses. */
export function parseLinuxStat(content: string): { ppid: number; ttyNr: number } | undefined {
  const fields = content
    .slice(content.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(fields[1]);
  const ttyNr = Number(fields[4]);
  return Number.isInteger(ppid) && Number.isInteger(ttyNr) ? { ppid, ttyNr } : undefined;
}

async function readLinuxProcess(pid: number, uid: number): Promise<ListedProcess | undefined> {
  try {
    const [owner, statContent] = await Promise.all([
      stat(`/proc/${pid}`),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
    const parsed = parseLinuxStat(statContent);
    if (!parsed) {
      return undefined;
    }
    const entry: ListedProcess = {
      pid,
      ppid: parsed.ppid,
      uid: owner.uid,
      hasTty: parsed.ttyNr !== 0,
    };
    if (owner.uid === uid) {
      // A removed directory reads as "<path> (deleted)" and therefore never matches.
      const [cwd, executable] = await Promise.all([
        readlink(`/proc/${pid}/cwd`).catch(() => undefined),
        readlink(`/proc/${pid}/exe`).catch(() => undefined),
      ]);
      entry.cwd = cwd;
      entry.executable = executable;
    }
    return entry;
  } catch {
    // The process exited or is not inspectable; skipping it can only cause a miss.
    return undefined;
  }
}

async function listLinuxProcesses(uid: number): Promise<ListedProcess[]> {
  const pids = (await readdir('/proc')).filter((name) => /^\d+$/.test(name)).map(Number);
  const entries = await Promise.all(pids.map((pid) => readLinuxProcess(pid, uid)));
  return entries.filter((entry): entry is ListedProcess => entry !== undefined);
}

export function platformProcessLister(
  platform: NodeJS.Platform,
  uid: number | undefined,
  timeoutMs = DEFAULT_LIST_TIMEOUT_MS
): ProcessLister | null {
  if (uid === undefined) {
    return null;
  }
  if (platform === 'darwin') {
    return () => listDarwinProcesses(uid, timeoutMs);
  }
  if (platform === 'linux') {
    return () => listLinuxProcesses(uid);
  }
  return null;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Process listing timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sendSignal(signaller: Signaller, pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    signaller(pid, signal);
    return true;
  } catch {
    // ESRCH: already gone. EPERM: not ours to signal; reported as a survivor.
    return false;
  }
}

function isAlive(signaller: Signaller, pid: number): boolean {
  try {
    signaller(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForExit(signaller: Signaller, pids: number[], graceMs: number) {
  const deadline = Date.now() + graceMs;
  let alive = pids.filter((pid) => isAlive(signaller, pid));
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())))
    );
    alive = alive.filter((pid) => isAlive(signaller, pid));
  }
  return alive;
}

/**
 * Sends SIGTERM to matching processes, waits a bounded grace period, then
 * re-lists and sends SIGKILL only to survivors that still match, so a reused
 * PID is never killed. Worst case is two listings plus both grace periods.
 * Throws when the worktree path is unsafe or identification fails.
 */
export async function sweepWorktreeProcesses(
  options: WorktreeProcessSweepOptions
): Promise<WorktreeProcessSweepResult> {
  const selfUid = options.selfUid ?? process.getuid?.();
  const listTimeoutMs = options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  const lister =
    options.listProcesses === undefined
      ? platformProcessLister(process.platform, selfUid, listTimeoutMs)
      : options.listProcesses;
  if (!lister || selfUid === undefined) {
    return { status: 'unsupported' };
  }
  const roots = await resolveWorktreeRoots(options.worktreePath, options.worktreeBasePath);
  const serverCwd = options.serverCwd ?? (await realpath(process.cwd()));
  if (roots.some((root) => isPathInsideRoot(serverCwd, root))) {
    throw new Error('Refusing to sweep a worktree that contains the server working directory');
  }
  const self = {
    pid: options.selfPid ?? process.pid,
    ppid: options.selfPid === undefined ? process.ppid : undefined,
    uid: selfUid,
  };
  const signaller: Signaller =
    options.signal ??
    ((pid, signal) => {
      process.kill(pid, signal);
    });

  const matched = selectWorktreeProcesses(await withTimeout(lister(), listTimeoutMs), roots, self);
  if (matched.length === 0) {
    return { status: 'swept', matched, terminated: [], killed: [], survivors: [] };
  }
  const signalled = matched.filter((pid) => sendSignal(signaller, pid, 'SIGTERM'));
  const unsignalled = matched.filter((pid) => !signalled.includes(pid));
  const remaining = await waitForExit(
    signaller,
    signalled,
    options.termGraceMs ?? DEFAULT_TERM_GRACE_MS
  );
  const terminated = signalled.filter((pid) => !remaining.includes(pid));
  if (remaining.length === 0) {
    return { status: 'swept', matched, terminated, killed: [], survivors: unsignalled };
  }

  // Escalate only for PIDs that still match: one that stopped matching has
  // exited, become a zombie, or been reused by an unrelated process.
  const stillMatching = new Set(
    selectWorktreeProcesses(await withTimeout(lister(), listTimeoutMs), roots, self)
  );
  const escalate = remaining.filter((pid) => stillMatching.has(pid));
  const killed = escalate.filter((pid) => sendSignal(signaller, pid, 'SIGKILL'));
  const unexited = await waitForExit(
    signaller,
    killed,
    options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  );
  return {
    status: 'swept',
    matched,
    terminated,
    killed,
    survivors: [...unsignalled, ...escalate.filter((pid) => !killed.includes(pid)), ...unexited],
  };
}
