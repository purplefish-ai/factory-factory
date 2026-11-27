import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import {
  groupHostProcesses,
  type HostProcess,
  type HostProcessGroup,
  type ProcessOwner,
  readHostProcesses,
} from './host-processes';

const execFileAsync = promisify(execFile);

/** One reading of the machine the backend runs on, as whole-host percentages. */
export interface HostMetricsSample {
  /** Epoch milliseconds. */
  at: number;
  cpuPercent: number;
  memoryPercent: number;
}

/**
 * A reader's view of the history. With a cursor still in the window, only the
 * samples taken after it; otherwise the whole window. Readers merge the samples
 * into what they hold and drop anything older than `oldestAt`, so they hold the
 * same window as the service.
 */
export interface HostMetricsHistory {
  samples: HostMetricsSample[];
  /** The cursor the samples continue from, or `null` when they are the whole window. */
  since: number | null;
  /** When the oldest sample still in the window was taken. */
  oldestAt: number;
}

export interface CpuTimes {
  idle: number;
  total: number;
}

export interface HostMetricsServiceOptions {
  readCpuTimes?: () => CpuTimes;
  readMemoryPercent?: () => Promise<number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readProcesses?: () => Promise<HostProcess[]>;
  cpuCount?: () => number;
}

/** The heaviest process groups on the machine, for the load popover. */
export interface HostProcessBreakdown {
  byCpu: HostProcessGroup[];
  byMemory: HostProcessGroup[];
}

const TOP_PROCESS_GROUPS = 5;

/**
 * Sampling is driven by reads, not a timer: the header polls every 5 seconds
 * while a tab is visible (every 15 on a phone with the details closed), so a
 * sample is taken only when someone is looking. The minimum gap sits just
 * under the fastest poll so each poll gets a fresh point, while several open
 * tabs share one sample.
 */
const MIN_SAMPLE_GAP_MS = 4000;
/** A gap this long means nobody was watching; old points would draw a false line. */
const STALE_AFTER_MS = 30_000;
/** Five minutes at the fastest poll rate. */
const HISTORY_CAPACITY = 60;
/** The popover's "Last 5 minutes", when samples are taken more slowly than every 5 seconds. */
const HISTORY_WINDOW_MS = 5 * 60_000;
/** CPU usage needs two readings; on a cold start, wait this long for the second. */
const CPU_PRIME_MS = 250;

export function readCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const { user, nice, sys, idle: cpuIdle, irq } = cpu.times;
    idle += cpuIdle;
    total += user + nice + sys + cpuIdle + irq;
  }
  return { idle, total };
}

export function cpuPercentBetween(previous: CpuTimes, current: CpuTimes): number {
  const total = current.total - previous.total;
  if (total <= 0) {
    return 0;
  }
  const busy = total - (current.idle - previous.idle);
  return clampPercent((busy / total) * 100);
}

/** Estimate Activity Monitor's Memory Used from physical page counts. */
function parseMacUsedMemoryBytes(stdout: string): number | null {
  const pageSize = Number(
    /^Mach Virtual Memory Statistics: \(page size of (\d+) bytes\)/m.exec(stdout)?.[1]
  );
  const anonymous = Number(/^Anonymous pages:[ \t]*(\d+)\.$/m.exec(stdout)?.[1]);
  const purgeable = Number(/^Pages purgeable:[ \t]*(\d+)\.$/m.exec(stdout)?.[1]);
  const wired = Number(/^Pages wired down:[ \t]*(\d+)\.$/m.exec(stdout)?.[1]);
  const compressed = Number(/^Pages occupied by compressor:[ \t]*(\d+)\.$/m.exec(stdout)?.[1]);
  if (
    pageSize <= 0 ||
    ![pageSize, anonymous, purgeable, wired, compressed].every(Number.isSafeInteger)
  ) {
    return null;
  }
  // Anonymous pages exclude the file cache. Deduct purgeable pages and use
  // the compressor's physical size to account for RAM occupied by compressed data.
  const usedBytes = (anonymous - purgeable + wired + compressed) * pageSize;
  return usedBytes >= 0 && Number.isSafeInteger(usedBytes) ? usedBytes : null;
}

function freeMemoryPercent(): number {
  return clampPercent((1 - os.freemem() / os.totalmem()) * 100);
}

async function readMacVmStat(): Promise<string> {
  const { stdout } = await execFileAsync('vm_stat', [], {
    encoding: 'utf8',
    timeout: 1000,
  });
  return stdout;
}

/** Use macOS page counts to exclude reclaimable cache from the RAM reading. */
export async function readMemoryPercent(
  platform: NodeJS.Platform = process.platform,
  readVmStat: () => Promise<string> = readMacVmStat
): Promise<number> {
  if (platform !== 'darwin') {
    return freeMemoryPercent();
  }
  try {
    const usedBytes = parseMacUsedMemoryBytes(await readVmStat());
    return usedBytes === null
      ? freeMemoryPercent()
      : clampPercent((usedBytes / os.totalmem()) * 100);
  } catch {
    return freeMemoryPercent();
  }
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class HostMetricsService {
  private readonly readCpuTimes: () => CpuTimes;
  private readonly readMemoryPercent: () => Promise<number>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private samples: HostMetricsSample[] = [];
  private cpuBaseline: CpuTimes | null = null;
  private inFlight: Promise<HostMetricsSample[]> | null = null;
  private readonly readProcesses: () => Promise<HostProcess[]>;
  private readonly cpuCount: () => number;

  constructor(options: HostMetricsServiceOptions = {}) {
    this.readCpuTimes = options.readCpuTimes ?? readCpuTimes;
    this.readMemoryPercent = options.readMemoryPercent ?? (() => readMemoryPercent());
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.readProcesses = options.readProcesses ?? readHostProcesses;
    this.cpuCount = options.cpuCount ?? (() => os.cpus().length);
  }

  /**
   * What is using the machine right now, read on demand (one `ps`) because
   * only an open popover asks. `owners` maps root pids to the workspace or
   * Factory Factory process that started them.
   */
  async getTopProcesses(owners: ReadonlyMap<number, ProcessOwner>): Promise<HostProcessBreakdown> {
    const groups = groupHostProcesses(await this.readProcesses(), owners, this.cpuCount());
    return {
      byCpu: groups.slice(0, TOP_PROCESS_GROUPS),
      byMemory: [...groups]
        .sort((a, b) => b.memoryBytes - a.memoryBytes)
        .slice(0, TOP_PROCESS_GROUPS),
    };
  }

  /** Recent samples, oldest first, taking a new one if the last is due. */
  getHistory(): Promise<HostMetricsSample[]> {
    const last = this.samples.at(-1);
    if (last && this.now() - last.at < MIN_SAMPLE_GAP_MS) {
      return Promise.resolve(this.samples);
    }
    if (!this.inFlight) {
      this.inFlight = this.sample().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /**
   * The history a reader does not have yet. `after` is the time of the newest
   * sample the reader holds; when that sample has left the window, or the
   * history restarted, the reader gets the whole window instead.
   */
  async getHistoryAfter(after?: number): Promise<HostMetricsHistory> {
    const samples = await this.getHistory();
    const oldestAt = samples[0]?.at ?? this.now();
    const cursor = samples.findIndex((sample) => sample.at === after);
    if (after !== undefined && cursor !== -1) {
      return { samples: samples.slice(cursor + 1), since: after, oldestAt };
    }
    return { samples, since: null, oldestAt };
  }

  private async sample(): Promise<HostMetricsSample[]> {
    const last = this.samples.at(-1);
    if (!last || this.now() - last.at > STALE_AFTER_MS) {
      this.samples = [];
      this.cpuBaseline = this.readCpuTimes();
      await this.sleep(CPU_PRIME_MS);
    }
    const memoryPercent = await this.readMemoryPercent();
    const cpuTimes = this.readCpuTimes();
    const cpuPercent = this.cpuBaseline ? cpuPercentBetween(this.cpuBaseline, cpuTimes) : 0;
    this.cpuBaseline = cpuTimes;
    const at = this.now();
    this.samples = [...this.samples, { at, cpuPercent, memoryPercent }]
      .slice(-HISTORY_CAPACITY)
      .filter((sample) => sample.at > at - HISTORY_WINDOW_MS);
    return this.samples;
  }
}

export const hostMetricsService = new HostMetricsService();
