import { beforeEach, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma-gen/client';

const state = vi.hoisted(() => ({
  transaction: vi.fn(),
  disconnect: vi.fn(),
  adapter: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@prisma-gen/client', () => ({
  PrismaClient: class {
    $transaction = state.transaction;
    $disconnect = state.disconnect;
  },
}));
vi.mock('@prisma/adapter-better-sqlite3', () => ({
  PrismaBetterSqlite3: class {
    constructor(options: unknown) {
      state.adapter(options);
    }
  },
}));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ warn: state.warn }),
}));
import { withBackupSnapshot } from './backup-snapshot';

beforeEach(() => {
  vi.resetAllMocks();
  state.transaction.mockImplementation((read) => read({ snapshot: true }));
  state.disconnect.mockResolvedValue(undefined);
});
const source = (rows: unknown): Pick<PrismaClient, '$queryRaw'> => ({
  $queryRaw: vi.fn().mockResolvedValue(rows),
});

it('opens the discovered main file physically readonly with finite transaction and busy budgets', async () => {
  const read = vi.fn().mockResolvedValue('exported');
  const db = source([{ seq: 0n, name: 'main', file: '/actual.db' }]);
  await expect(withBackupSnapshot(db, read)).resolves.toBe('exported');
  expect(db.$queryRaw).toHaveBeenCalledWith(['PRAGMA database_list']);
  expect(state.adapter).toHaveBeenCalledWith({
    url: '/actual.db',
    readonly: true,
    fileMustExist: true,
    timeout: 5000,
  });
  expect(state.transaction).toHaveBeenCalledWith(read, { timeout: 120_000 });
  expect(read).toHaveBeenCalledWith({ snapshot: true });
  expect(state.disconnect).toHaveBeenCalledOnce();
});

it.each([
  null,
  {},
  [],
  [{ name: 'temp', file: '/temp.db' }],
  [{ name: 'main', file: '' }],
  [{ name: 'main', file: ':memory:' }],
  [{ name: 'main', file: 4 }],
  [
    { name: 'main', file: '/one.db' },
    { name: 'main', file: '/two.db' },
  ],
])('rejects missing, non-file or malformed main database paths: %j', async (rows) => {
  await expect(withBackupSnapshot(source(rows), vi.fn())).rejects.toThrow();
  expect(state.adapter).not.toHaveBeenCalled();
});

it('disconnects after callback failure and preserves that error when cleanup also fails', async () => {
  const primary = new Error('read failed');
  const cleanup = new Error('disconnect failed');
  state.disconnect.mockRejectedValue(cleanup);
  await expect(
    withBackupSnapshot(source([{ name: 'main', file: '/db' }]), () => Promise.reject(primary))
  ).rejects.toBe(primary);
  expect(state.disconnect).toHaveBeenCalledOnce();
  expect(state.warn).toHaveBeenCalled();
});

it('disconnects after a connection/transaction failure', async () => {
  const primary = new Error('open failed');
  state.transaction.mockRejectedValue(primary);
  await expect(withBackupSnapshot(source([{ name: 'main', file: '/db' }]), vi.fn())).rejects.toBe(
    primary
  );
  expect(state.disconnect).toHaveBeenCalledOnce();
});

it('surfaces a cleanup failure when the read succeeded', async () => {
  const cleanup = new Error('disconnect failed');
  state.disconnect.mockRejectedValue(cleanup);
  await expect(
    withBackupSnapshot(source([{ name: 'main', file: '/db' }]), async () => 'ok')
  ).rejects.toBe(cleanup);
});
