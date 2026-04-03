import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentLogbook, AgentLogbookEntry, AutoIterationConfig } from './auto-iteration.types';

const LOGBOOK_DIR = '.factory-factory';
const LOGBOOK_FILENAME = 'auto-iteration-logbook.json';
const STRATEGY_FILENAME = 'auto-iteration-strategy.md';

function getLogbookPath(worktreePath: string): string {
  return path.join(worktreePath, LOGBOOK_DIR, LOGBOOK_FILENAME);
}

export class LogbookService {
  /** Initialize a new logbook with baseline measurement. */
  async initialize(
    worktreePath: string,
    workspaceId: string,
    config: AutoIterationConfig,
    baselineOutput: string,
    baselineMetricSummary: string
  ): Promise<void> {
    const logbook: AgentLogbook = {
      workspaceId,
      config,
      baseline: {
        testOutput: baselineOutput,
        metricSummary: baselineMetricSummary,
        evaluatedAt: new Date().toISOString(),
      },
      iterations: [],
    };
    await this.write(worktreePath, logbook);
  }

  /** Append an iteration entry to the logbook. */
  async appendEntry(worktreePath: string, entry: AgentLogbookEntry): Promise<void> {
    const logbook = await this.read(worktreePath);
    if (!logbook) {
      throw new Error('Logbook not found — was it initialized?');
    }
    logbook.iterations.push(entry);
    await this.write(worktreePath, logbook);
  }

  /** Read the logbook from disk. Returns null if the file does not exist. */
  async read(worktreePath: string): Promise<AgentLogbook | null> {
    const filePath = getLogbookPath(worktreePath);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Validate minimal expected shape before returning
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof parsed.workspaceId !== 'string' ||
        !Array.isArray(parsed.iterations)
      ) {
        throw new Error(`Invalid logbook structure in ${filePath}`);
      }
      return parsed as AgentLogbook;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /** Read the user-editable strategy file. Returns null if the file does not exist. */
  async readStrategyFile(worktreePath: string): Promise<string | null> {
    const filePath = path.join(worktreePath, LOGBOOK_DIR, STRATEGY_FILENAME);
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /** Seed the default strategy file. No-op if the file already exists. */
  async writeStrategyFile(worktreePath: string, content: string): Promise<void> {
    const filePath = path.join(worktreePath, LOGBOOK_DIR, STRATEGY_FILENAME);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.writeFile(filePath, content, { flag: 'wx' }); // wx = create exclusive, fail if exists
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return; // File already exists — don't overwrite user edits
      }
      throw err;
    }
  }

  private async write(worktreePath: string, logbook: AgentLogbook): Promise<void> {
    const filePath = getLogbookPath(worktreePath);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    // Atomic write: write to a temp file then rename to prevent corruption on interruption
    const tmpPath = `${filePath}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(logbook, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }
}

export const logbookService = new LogbookService();
