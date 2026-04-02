import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentLogbook, AgentLogbookEntry, AutoIterationConfig } from './auto-iteration.types';

const LOGBOOK_DIR = '.factory-factory';
const LOGBOOK_FILENAME = 'auto-iteration-logbook.json';

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

  /** Read the logbook from disk. Returns null if not found. */
  async read(worktreePath: string): Promise<AgentLogbook | null> {
    const filePath = getLogbookPath(worktreePath);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const logbook: AgentLogbook = JSON.parse(raw);
      return logbook;
    } catch {
      return null;
    }
  }

  private async write(worktreePath: string, logbook: AgentLogbook): Promise<void> {
    const filePath = getLogbookPath(worktreePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(logbook, null, 2), 'utf-8');
  }
}

export const logbookService = new LogbookService();
