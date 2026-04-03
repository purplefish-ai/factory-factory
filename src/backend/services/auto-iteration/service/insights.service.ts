import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const INSIGHTS_DIR = '.factory-factory';
const INSIGHTS_FILENAME = 'auto-iteration-insights.md';

/** Maximum character length of insights injected into prompts (~2000 tokens). */
const INJECTION_CHAR_LIMIT = 8000;

export function getInsightsPath(worktreePath: string): string {
  return path.join(worktreePath, INSIGHTS_DIR, INSIGHTS_FILENAME);
}

export class InsightsService {
  /**
   * Create the insights file if it does not exist yet.
   * No-op if the file already exists (preserves content across runs).
   */
  async initialize(worktreePath: string): Promise<void> {
    const filePath = getInsightsPath(worktreePath);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.access(filePath);
    } catch {
      // File does not exist — create with header
      await fs.writeFile(
        filePath,
        '# Auto-Iteration Insights\n\n<!-- Add ideas, hypotheses, deferred approaches, or observations here.\n     Tag entries with [open], [resolved], or [obsolete]. Untagged entries are treated as [open]. -->\n',
        'utf-8'
      );
    }
  }

  /** Read the full insights file. Returns null if the file does not exist. */
  async read(worktreePath: string): Promise<string | null> {
    const filePath = getInsightsPath(worktreePath);
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /** Write the full insights file (used by the tRPC save endpoint). */
  async write(worktreePath: string, content: string): Promise<void> {
    const filePath = getInsightsPath(worktreePath);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Return only the [open] entries from the file, capped to INJECTION_CHAR_LIMIT characters.
   * Returns null if the file is absent or contains no open content.
   */
  async getOpenContent(worktreePath: string): Promise<string | null> {
    const raw = await this.read(worktreePath);
    if (!raw) {
      return null;
    }

    // Filter out lines/blocks that are explicitly resolved or obsolete.
    // Strategy: split into non-empty paragraphs (blank-line separated), drop any that
    // contain [resolved] or [obsolete] tags, reassemble, then truncate.
    const paragraphs = raw.split(/\n{2,}/);
    const open = paragraphs.filter((p) => {
      // Skip HTML comments — they may contain instructional mentions of tags
      const withoutComments = p.replace(/<!--[\s\S]*?-->/g, '');
      const lower = withoutComments.toLowerCase();
      return !(lower.includes('[resolved]') || lower.includes('[obsolete]'));
    });

    const filtered = open.join('\n\n').trim();
    if (!filtered || (filtered.startsWith('#') && filtered.split('\n').length <= 2)) {
      // Only a header remains — nothing substantive
      return null;
    }

    if (filtered.length <= INJECTION_CHAR_LIMIT) {
      return filtered;
    }

    // Truncate from the start (oldest content) to keep recent entries
    return `... (earlier entries truncated)\n\n${filtered.slice(-INJECTION_CHAR_LIMIT)}`;
  }
}

export const insightsService = new InsightsService();
