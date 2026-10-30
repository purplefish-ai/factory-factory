import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TunedPrismaBetterSqlite3 } from './sqlite-adapter';

describe('TunedPrismaBetterSqlite3', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function readPragma(
    adapter: Awaited<ReturnType<TunedPrismaBetterSqlite3['connect']>>,
    name: string
  ): Promise<unknown> {
    const result = await adapter.queryRaw({ sql: `PRAGMA ${name}`, args: [], argTypes: [] });
    return result.rows[0]?.[0];
  }

  it('enables WAL and relaxed fsync on each connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-sqlite-adapter-'));
    tempDirs.push(dir);
    const adapter = await new TunedPrismaBetterSqlite3({ url: join(dir, 'test.db') }).connect();

    try {
      expect(await readPragma(adapter, 'journal_mode')).toBe('wal');
      // synchronous: 1 = NORMAL (default is 2 = FULL).
      expect(Number(await readPragma(adapter, 'synchronous'))).toBe(1);
      expect(Number(await readPragma(adapter, 'busy_timeout'))).toBe(5000);
      // temp_store: 2 = MEMORY.
      expect(Number(await readPragma(adapter, 'temp_store'))).toBe(2);
    } finally {
      await adapter.dispose();
    }
  });
});
