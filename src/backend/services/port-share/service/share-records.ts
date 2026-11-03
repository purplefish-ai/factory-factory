import { execFile } from 'node:child_process';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { writeFileAtomic } from '@/backend/lib/atomic-file';
import { isProcessRunning } from '@/backend/lib/process-liveness';

const execFileAsync = promisify(execFile);

export interface ShareRecord {
  /** Process group of the foreground `tailscale serve` (the wrapper and the real CLI). */
  pgid: number;
  httpsPort: number;
  forwarderPort: number;
}

const recordFileSchema = z.object({
  ownerPid: z.number().int().positive(),
  shares: z.array(
    z.object({
      pgid: z.number().int().gt(1),
      httpsPort: z.number().int().positive(),
      forwarderPort: z.number().int().positive(),
    })
  ),
});

interface ProcessEntry {
  pgid: number;
  args: string;
}

export interface StaleShareDependencies {
  isRunning(pid: number): Promise<boolean>;
  listProcesses(): Promise<ProcessEntry[]>;
  killGroup(pgid: number): void;
}

async function listProcesses(): Promise<ProcessEntry[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pgid=,args='], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    return match?.[1] && match[2] ? [{ pgid: Number(match[1]), args: match[2] }] : [];
  });
}

const defaultDependencies: StaleShareDependencies = {
  isRunning: isProcessRunning,
  listProcesses,
  killGroup: (pgid) => process.kill(-pgid, 'SIGTERM'),
};

async function readRecordFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Returns whether the group is gone or was signalled. */
function signalGroup(dependencies: StaleShareDependencies, pgid: number): boolean {
  try {
    dependencies.killGroup(pgid);
    return true;
  } catch (error) {
    // ESRCH: the group exited between listing and signalling.
    return error instanceof Error && 'code' in error && error.code === 'ESRCH';
  }
}

/** A recorded group is only signalled while it still runs this exact share. */
function isRecordedServe(entry: ProcessEntry, share: ShareRecord): boolean {
  return (
    entry.pgid === share.pgid &&
    /\bserve\b/.test(entry.args) &&
    entry.args.includes(`--https=${share.httpsPort}`) &&
    entry.args.includes(`http://127.0.0.1:${share.forwarderPort}`)
  );
}

/**
 * Persists this backend's Serve process groups so the next start can stop
 * ones a crash left behind. Each backend owns one file named by its PID, so
 * concurrent instances sharing a data directory never stop each other's shares.
 */
export class ShareRecordStore {
  constructor(
    private readonly directory: string,
    private readonly ownerPid = process.pid
  ) {}

  private get ownPath(): string {
    return join(this.directory, `${this.ownerPid}.json`);
  }

  async write(shares: readonly ShareRecord[]): Promise<void> {
    // Crash recovery signals process groups, which Windows does not have.
    if (process.platform === 'win32') {
      return;
    }
    if (shares.length === 0) {
      await rm(this.ownPath, { force: true });
      return;
    }
    await writeFileAtomic(this.ownPath, JSON.stringify({ ownerPid: this.ownerPid, shares }));
  }

  /**
   * Stops Serve groups recorded by backends that are no longer running. A
   * record is removed only after its groups are gone, so a failed sweep is
   * retried on the next start.
   */
  async stopStaleShares(
    dependencies: StaleShareDependencies = defaultDependencies
  ): Promise<number> {
    if (process.platform === 'win32') {
      return 0;
    }
    const staleFiles = await this.findStaleFiles(dependencies);
    if (staleFiles.length === 0) {
      return 0;
    }
    const processes = await dependencies.listProcesses();
    let stopped = 0;
    for (const { path, shares } of staleFiles) {
      let allStopped = true;
      for (const share of shares) {
        if (!processes.some((entry) => isRecordedServe(entry, share))) {
          continue;
        }
        if (signalGroup(dependencies, share.pgid)) {
          stopped += 1;
        } else {
          allStopped = false;
        }
      }
      if (allStopped) {
        await rm(path, { force: true });
      }
    }
    return stopped;
  }

  private async findStaleFiles(
    dependencies: StaleShareDependencies
  ): Promise<{ path: string; shares: ShareRecord[] }[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return [];
    }
    const stale: { path: string; shares: ShareRecord[] }[] = [];
    for (const name of names.filter((file) => /^\d+\.json$/.test(file))) {
      const path = join(this.directory, name);
      const parsed = recordFileSchema.safeParse(await readRecordFile(path));
      const owner = parsed.success ? parsed.data.ownerPid : undefined;
      if (owner === this.ownerPid || (owner && (await dependencies.isRunning(owner)))) {
        continue;
      }
      stale.push({ path, shares: parsed.success ? parsed.data.shares : [] });
    }
    return stale;
  }
}
