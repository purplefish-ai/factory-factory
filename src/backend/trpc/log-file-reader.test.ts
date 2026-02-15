import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFilteredLogEntriesPage } from './log-file-reader';

interface TestLogEntry {
  level: 'error' | 'warn' | 'info' | 'debug';
  message: string;
  timestamp: string;
  component?: string;
}

function makeLogLine(entry: TestLogEntry): string {
  return JSON.stringify({
    level: entry.level,
    timestamp: entry.timestamp,
    message: entry.message,
    context: {
      component: entry.component ?? 'test-component',
    },
  });
}

describe('readFilteredLogEntriesPage', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function writeLogFile(lines: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'log-reader-test-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'server.log');
    await writeFile(filePath, `${lines.join('\n')}\n`, 'utf-8');
    return filePath;
  }

  it('returns newest matching entries first and marks total as lower-bound when truncated', async () => {
    const filePath = await writeLogFile([
      makeLogLine({
        level: 'info',
        message: 'oldest',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
      makeLogLine({
        level: 'info',
        message: 'middle',
        timestamp: '2026-01-01T00:00:01.000Z',
      }),
      makeLogLine({
        level: 'info',
        message: 'newest',
        timestamp: '2026-01-01T00:00:02.000Z',
      }),
    ]);

    const result = await readFilteredLogEntriesPage(filePath, {}, { offset: 0, limit: 2 });

    expect(result.entries.map((entry) => entry.message)).toEqual(['newest', 'middle']);
    expect(result.hasMore).toBe(true);
    expect(result.totalIsExact).toBe(false);
    expect(result.total).toBe(3);
  });

  it('returns exact totals when all matching entries are scanned', async () => {
    const filePath = await writeLogFile([
      makeLogLine({
        level: 'info',
        message: 'only-one',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
      makeLogLine({
        level: 'warn',
        message: 'only-two',
        timestamp: '2026-01-01T00:00:01.000Z',
      }),
    ]);

    const result = await readFilteredLogEntriesPage(filePath, {}, { offset: 0, limit: 10 });

    expect(result.entries.map((entry) => entry.message)).toEqual(['only-two', 'only-one']);
    expect(result.hasMore).toBe(false);
    expect(result.totalIsExact).toBe(true);
    expect(result.total).toBe(2);
  });

  it('applies search, level, and date filters', async () => {
    const filePath = await writeLogFile([
      makeLogLine({
        level: 'info',
        message: 'bootstrap complete',
        timestamp: '2026-01-01T00:00:00.000Z',
        component: 'boot',
      }),
      makeLogLine({
        level: 'error',
        message: 'db failed',
        timestamp: '2026-01-01T00:05:00.000Z',
        component: 'database',
      }),
      makeLogLine({
        level: 'error',
        message: 'network retry',
        timestamp: '2026-01-01T00:10:00.000Z',
        component: 'network',
      }),
    ]);

    const result = await readFilteredLogEntriesPage(
      filePath,
      {
        level: 'error',
        search: 'db',
        sinceMs: new Date('2026-01-01T00:02:00.000Z').getTime(),
        untilMs: new Date('2026-01-01T00:08:00.000Z').getTime(),
      },
      { offset: 0, limit: 10 }
    );

    expect(result.entries.map((entry) => entry.message)).toEqual(['db failed']);
    expect(result.hasMore).toBe(false);
    expect(result.totalIsExact).toBe(true);
    expect(result.total).toBe(1);
  });

  it('skips malformed lines and supports offset pagination', async () => {
    const filePath = await writeLogFile([
      makeLogLine({
        level: 'info',
        message: 'one',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
      '{not-json}',
      makeLogLine({
        level: 'info',
        message: 'two',
        timestamp: '2026-01-01T00:00:01.000Z',
      }),
      makeLogLine({
        level: 'info',
        message: 'three',
        timestamp: '2026-01-01T00:00:02.000Z',
      }),
      makeLogLine({
        level: 'info',
        message: 'four',
        timestamp: '2026-01-01T00:00:03.000Z',
      }),
    ]);

    const result = await readFilteredLogEntriesPage(filePath, {}, { offset: 1, limit: 2 });

    expect(result.entries.map((entry) => entry.message)).toEqual(['three', 'two']);
    expect(result.hasMore).toBe(true);
    expect(result.totalIsExact).toBe(false);
    expect(result.total).toBe(4);
  });

  it('preserves UTF-8 characters split across chunk boundaries', async () => {
    const timestamp = '2026-01-01T00:00:00.000Z';
    const level: TestLogEntry['level'] = 'info';
    const component = 'test-component';
    let message: string | null = null;

    for (let tailLength = 65_000; tailLength < 66_500; tailLength += 1) {
      const candidate = `🙂${'a'.repeat(tailLength)}`;
      const line = makeLogLine({ level, timestamp, component, message: candidate });
      const lineBytes = Buffer.from(`${line}\n`, 'utf-8');
      const emojiStart = lineBytes.indexOf(Buffer.from('🙂'));

      if (emojiStart < 0) {
        continue;
      }

      const bytesFromEmojiStartToFileEnd = lineBytes.length - emojiStart;
      if (bytesFromEmojiStartToFileEnd > 65_536 && bytesFromEmojiStartToFileEnd < 65_540) {
        message = candidate;
        break;
      }
    }

    expect(message).not.toBeNull();
    const filePath = await writeLogFile([
      makeLogLine({ level, timestamp, component, message: message! }),
    ]);
    const result = await readFilteredLogEntriesPage(filePath, {}, { offset: 0, limit: 1 });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.message).toBe(message);
  });
});
