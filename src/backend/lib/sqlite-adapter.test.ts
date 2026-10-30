import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { TunedPrismaBetterSqlite3 } from './sqlite-adapter';

type ConnectedAdapter = Awaited<ReturnType<TunedPrismaBetterSqlite3['connect']>>;

describe('TunedPrismaBetterSqlite3', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDatabasePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ff-sqlite-adapter-'));
    tempDirs.push(dir);
    return join(dir, 'test.db');
  }

  async function readPragma(adapter: ConnectedAdapter, name: string): Promise<unknown> {
    const result = await adapter.queryRaw({ sql: `PRAGMA ${name}`, args: [], argTypes: [] });
    return result.rows[0]?.[0];
  }

  async function expectTunedPragmas(adapter: ConnectedAdapter): Promise<void> {
    expect(await readPragma(adapter, 'journal_mode')).toBe('wal');
    // synchronous: 1 = NORMAL (default is 2 = FULL).
    expect(Number(await readPragma(adapter, 'synchronous'))).toBe(1);
    expect(Number(await readPragma(adapter, 'busy_timeout'))).toBe(5000);
    // temp_store: 2 = MEMORY.
    expect(Number(await readPragma(adapter, 'temp_store'))).toBe(2);
  }

  it('enables WAL and relaxed fsync on each connection', async () => {
    const factory = new TunedPrismaBetterSqlite3({ url: tempDatabasePath() });
    const first = await factory.connect();
    const second = await factory.connect();

    try {
      await expectTunedPragmas(first);
      // Per-connection pragmas must be reapplied, not just persisted in the file.
      await expectTunedPragmas(second);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it('disposes the connection when applying pragmas fails', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const failure = new Error('pragma failed');
    vi.spyOn(PrismaBetterSqlite3.prototype, 'connect').mockResolvedValue(
      unsafeCoerce<ConnectedAdapter>({
        executeScript: vi.fn().mockRejectedValue(failure),
        dispose,
      })
    );

    await expect(new TunedPrismaBetterSqlite3({ url: tempDatabasePath() }).connect()).rejects.toBe(
      failure
    );
    expect(dispose).toHaveBeenCalledOnce();
  });
});
