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
 * while a tab is visible, so a sample is taken only when someone is looking.
 * The minimum gap sits just under that poll so each poll gets a fresh point,
 * while several open tabs share one sample.
 */
const MIN_SAMPLE_GAP_MS = 4000;
/** A gap this long means nobody was watching; old points would draw a false line. */
const STALE_AFTER_MS = 30_000;
/** Five minutes at the header's poll rate. */
const HISTORY_CAPACITY = 60;
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

/**
 * Parses `sysctl -n kern.memorystatus_level`: the percentage of memory macOS
 * considers available, the figure behind Activity Monitor's memory pressure.
 */
export function parseMemoryStatusLevel(stdout: string): number | null {
  const level = Number.parseInt(stdout.trim(), 10);
  if (!Number.isFinite(level) || level < 0 || level > 100) {
    return null;
  }
  return 100 - level;
}

function freeMemoryPercent(): number {
  return clampPercent((1 - os.freemem() / os.totalmem()) * 100);
}

async function readMemoryStatusLevel(): Promise<string> {
  const { stdout } = await execFileAsync('sysctl', ['-n', 'kern.memorystatus_level'], {
    encoding: 'utf8',
    timeout: 1000,
  });
  return stdout;
}

/**
 * Linux and Windows report reclaimable memory as free. macOS counts only
 * untouched pages, so a healthy Mac with a large file cache looks nearly full;
 * ask the kernel's memory-pressure level instead.
 */
export async function readMemoryPercent(
  platform: NodeJS.Platform = process.platform,
  readStatusLevel: () => Promise<string> = readMemoryStatusLevel
): Promise<number> {
  if (platform !== 'darwin') {
    return freeMemoryPercent();
  }
  try {
    return parseMemoryStatusLevel(await readStatusLevel()) ?? freeMemoryPercent();
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
    this.samples = [...this.samples, { at: this.now(), cpuPercent, memoryPercent }].slice(
      -HISTORY_CAPACITY
    );
    return this.samples;
  }
}

export const hostMetricsService = new HostMetricsService();
