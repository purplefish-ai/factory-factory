import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { beforeEach, expect, it, vi } from 'vitest';
import { ApplicationError } from '@/backend/lib/application-error';
import { TunedPrismaBetterSqlite3 } from '@/backend/lib/sqlite-adapter';
import { Prisma } from '@prisma-gen/client';
const state = vi.hoisted(() => ({
  constructed: vi.fn(),
  adapterOptions: vi.fn(),
  logError: vi.fn(),
  transaction: vi.fn(
    async (read: () => Promise<unknown>, _options?: { timeout: number }) => await read()
  ),
  disconnect: vi.fn(async () => undefined),
}));
vi.mock('@prisma/adapter-better-sqlite3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisma/adapter-better-sqlite3')>();
  return {
    ...actual,
    PrismaBetterSqlite3: class extends actual.PrismaBetterSqlite3 {
      constructor(options: ConstructorParameters<typeof actual.PrismaBetterSqlite3>[0]) {
        super(options);
        state.adapterOptions(options);
      }
    },
  };
});
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ error: state.logError }),
}));
vi.mock('@prisma-gen/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@prisma-gen/client')>()),
  PrismaClient: class {
    constructor(options: unknown) {
      state.constructed(options);
    }
    $transaction = state.transaction;
    $disconnect = state.disconnect;
  },
}));
import { withBackupImport, withBackupSnapshot } from './backup-snapshot';
beforeEach(() => vi.clearAllMocks());

it.each(
  [
    [{ name: 'main', file: '' }],
    [{ name: 'attached', file: '/unrelated.db' }],
    [{ name: 'main', file: 'relative.db' }],
  ].map((rows) => ({ rows }))
)(
  'refuses an unavailable or non-file-backed main database rather than opening a default: $rows',
  async ({ rows }) => {
    const source = { $queryRaw: vi.fn().mockResolvedValue(rows) };
    await expect(withBackupSnapshot(source, async () => 'unused')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(state.constructed).not.toHaveBeenCalled();
  }
);
it('closes its private reader after a successful snapshot', async () => {
  const source = { $queryRaw: vi.fn().mockResolvedValue([{ name: 'main', file: '/main.db' }]) };
  await expect(withBackupSnapshot(source, async () => 'snapshot')).resolves.toBe('snapshot');
  expect(state.disconnect).toHaveBeenCalledOnce();
});
it('closes its private reader when the operation rejects', async () => {
  const source = { $queryRaw: vi.fn().mockResolvedValue([{ name: 'main', file: '/main.db' }]) };
  const failure = new Error('Invalid retained snapshot');
  await expect(withBackupSnapshot(source, () => Promise.reject(failure))).rejects.toBe(failure);
  expect(state.disconnect).toHaveBeenCalledOnce();
});

it.each([withBackupSnapshot, withBackupImport])(
  'preserves the operation error when cleanup also fails',
  async (run) => {
    const source = { $queryRaw: vi.fn().mockResolvedValue([{ name: 'main', file: '/main.db' }]) };
    const failure = new ApplicationError('PRECONDITION_FAILED', 'Primary operation failure');
    const cleanup = new Error('Secondary close failure');
    state.disconnect.mockRejectedValueOnce(cleanup);
    await expect(run(source, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(state.disconnect).toHaveBeenCalledOnce();
    expect(state.logError).toHaveBeenCalledWith(
      'Failed to close backup connection after operation failure',
      cleanup
    );
  }
);
it.each([withBackupSnapshot, withBackupImport])(
  'reports cleanup failure after an otherwise successful operation',
  async (run) => {
    const source = { $queryRaw: vi.fn().mockResolvedValue([{ name: 'main', file: '/main.db' }]) };
    const cleanup = new Error('Close failure');
    state.disconnect.mockRejectedValueOnce(cleanup);
    await expect(run(source, async () => 'success')).rejects.toBe(cleanup);
    expect(state.disconnect).toHaveBeenCalledOnce();
    expect(state.logError).not.toHaveBeenCalled();
  }
);

it('maps SQLite writer contention to a retryable whole-import conflict without hiding the cause', async () => {
  const source = { $queryRaw: vi.fn().mockResolvedValue([{ name: 'main', file: '/main.db' }]) };
  const busy = new Prisma.PrismaClientKnownRequestError('SQLite busy snapshot', {
    code: 'P1008',
    clientVersion: 'test',
  });
  await expect(withBackupImport(source, () => Promise.reject(busy))).rejects.toMatchObject({
    code: 'CONFLICT',
    cause: busy,
  });
  expect(state.disconnect).toHaveBeenCalledOnce();
});
it('passes through the read operation P1008 error without classifying it as an import conflict', async () => {
  const source = { $queryRaw: vi.fn().mockResolvedValue([{ name: 'main', file: '/main.db' }]) };
  const busy = new Prisma.PrismaClientKnownRequestError('SQLite busy', {
    code: 'P1008',
    clientVersion: 'test',
  });
  await expect(withBackupSnapshot(source, () => Promise.reject(busy))).rejects.toBe(busy);
  expect(state.disconnect).toHaveBeenCalledOnce();
});

it('reports an exhausted private import transaction as a retryable whole-package conflict', async () => {
  const source = { $queryRaw: vi.fn().mockResolvedValue([{ name: 'main', file: '/main.db' }]) };
  const expired = new Prisma.PrismaClientKnownRequestError('Transaction expired', {
    code: 'P2028',
    clientVersion: 'test',
  });
  await expect(withBackupImport(source, () => Promise.reject(expired))).rejects.toMatchObject({
    code: 'CONFLICT',
    cause: expired,
  });
  expect(state.disconnect).toHaveBeenCalledOnce();
});

it('constructs a physically readonly reader and separately tuned writer with bounded transaction budgets', async () => {
  const source = { $queryRaw: vi.fn().mockResolvedValue([{ name: 'main', file: '/main.db' }]) };
  await withBackupSnapshot(source, async () => 'read');
  expect(state.constructed).toHaveBeenLastCalledWith({ adapter: expect.any(PrismaBetterSqlite3) });
  expect(state.adapterOptions).toHaveBeenLastCalledWith({
    url: '/main.db',
    readonly: true,
    fileMustExist: true,
    timeout: 5000,
  });
  await withBackupImport(source, async () => 'write');
  expect(state.constructed).toHaveBeenLastCalledWith({
    adapter: expect.any(TunedPrismaBetterSqlite3),
  });
  expect(state.adapterOptions).toHaveBeenLastCalledWith({ url: '/main.db', fileMustExist: true });
  for (const call of state.transaction.mock.calls) {
    expect(call[1]).toEqual({ timeout: 120_000 });
  }
});
it('rejects malformed database-list metadata before constructing either private connection', async () => {
  for (const run of [withBackupSnapshot, withBackupImport]) {
    const source = { $queryRaw: vi.fn().mockResolvedValue([{ name: 'main', file: 42 }]) };
    await expect(run(source, async () => 'unused')).rejects.toThrow(/expected string/);
    expect(state.constructed).not.toHaveBeenCalled();
  }
});
