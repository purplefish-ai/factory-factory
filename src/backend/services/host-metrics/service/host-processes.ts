import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** One row of `ps`. CPU is ps's figure: 100 means one full core. */
export interface HostProcess {
  pid: number;
  ppid: number;
  cpuPercent: number;
  memoryBytes: number;
  command: string;
}

export interface ProcessWorkspace {
  id: string;
  projectSlug: string;
}

/** Who a process tree belongs to, keyed by the tree's root pid. */
export interface ProcessOwner {
  key: string;
  label: string;
  kind: 'workspace' | 'factory';
  workspace: ProcessWorkspace | null;
}

/**
 * Processes counted the way a person names them: everything under an agent or
 * terminal as its workspace, every helper of a macOS app as the app, anything
 * else by executable name.
 */
export interface HostProcessGroup {
  key: string;
  label: string;
  kind: 'workspace' | 'factory' | 'app' | 'process';
  workspace: ProcessWorkspace | null;
  /** Share of the whole machine, so it reads against the header's CPU figure. */
  cpuPercent: number;
  memoryBytes: number;
  processCount: number;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/;

/** Parses `ps -A -o pid=,ppid=,pcpu=,rss=,comm=`; RSS is in kilobytes. */
export function parsePsOutput(stdout: string): HostProcess[] {
  const processes: HostProcess[] = [];
  for (const line of stdout.split('\n')) {
    const match = PS_LINE.exec(line);
    if (!match) {
      continue;
    }
    const [, pid, ppid, cpu, rss, command] = match;
    processes.push({
      pid: Number(pid),
      ppid: Number(ppid),
      cpuPercent: Number(cpu),
      memoryBytes: Number(rss) * 1024,
      command: (command ?? '').trim(),
    });
  }
  return processes;
}

/**
 * The outermost `.app` bundle in a macOS path, so Chrome's helpers count as
 * Chrome. Only absolute paths name a bundle; a relative one is however the
 * process was started.
 */
function appBundleName(command: string): string | null {
  if (!command.startsWith('/')) {
    return null;
  }
  const match = /\/([^/]+)\.app(?:\/|$)/.exec(command);
  return match?.[1] ?? null;
}

function unownedGroup(command: string): Pick<HostProcessGroup, 'key' | 'label' | 'kind'> {
  const app = appBundleName(command);
  if (app) {
    return { key: `app:${app}`, label: app, kind: 'app' };
  }
  const name = basename(command) || command;
  return { key: `process:${name}`, label: name, kind: 'process' };
}

/**
 * Sums processes into groups, largest first by CPU. A process belongs to the
 * nearest ancestor (or itself) in `owners`, so an agent's dev server counts
 * toward its workspace rather than the Factory Factory server above it.
 */
export function groupHostProcesses(
  processes: readonly HostProcess[],
  owners: ReadonlyMap<number, ProcessOwner>,
  cpuCount: number
): HostProcessGroup[] {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const ownerOf = new Map<number, ProcessOwner | null>();
  const findOwner = (pid: number): ProcessOwner | null => {
    const chain: number[] = [];
    let current: number | undefined = pid;
    let found: ProcessOwner | null = null;
    // The visited set guards against a pid reused while ps was reading.
    const visited = new Set<number>();
    while (current !== undefined && current > 0 && !visited.has(current)) {
      visited.add(current);
      const cached = ownerOf.get(current);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      const owner = owners.get(current);
      if (owner) {
        found = owner;
        break;
      }
      chain.push(current);
      current = byPid.get(current)?.ppid;
    }
    for (const visitedPid of chain) {
      ownerOf.set(visitedPid, found);
    }
    return found;
  };

  const groups = new Map<string, HostProcessGroup>();
  const cores = Math.max(1, cpuCount);
  for (const process of processes) {
    const owner = findOwner(process.pid);
    const identity = owner
      ? { key: owner.key, label: owner.label, kind: owner.kind }
      : unownedGroup(process.command);
    const group = groups.get(identity.key) ?? {
      ...identity,
      workspace: owner?.workspace ?? null,
      cpuPercent: 0,
      memoryBytes: 0,
      processCount: 0,
    };
    group.cpuPercent += process.cpuPercent / cores;
    group.memoryBytes += process.memoryBytes;
    group.processCount += 1;
    groups.set(identity.key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, cpuPercent: Math.round(group.cpuPercent * 10) / 10 }))
    .sort((a, b) => b.cpuPercent - a.cpuPercent);
}

/**
 * macOS `pcpu` is a recent decaying average; Linux procps reports the
 * lifetime average, so a long-lived process that just went busy reads low.
 */
export async function readHostProcesses(): Promise<HostProcess[]> {
  // -ww: no width limit, so long app bundle paths are not cut short.
  const { stdout } = await execFileAsync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pcpu=,rss=,comm='], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return parsePsOutput(stdout);
}
