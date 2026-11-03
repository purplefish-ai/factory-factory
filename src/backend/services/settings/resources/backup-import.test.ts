import { beforeEach, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
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
vi.mock('@/backend/lib/sqlite-adapter', () => ({
  TunedPrismaBetterSqlite3: class {
    constructor(options: unknown) {
      state.adapter(options);
    }
  },
}));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ warn: state.warn }),
}));
import { withBackupImport, withBackupSnapshot } from './backup-snapshot';

const source = (
  rows: unknown = [{ name: 'main', file: '/actual.db' }]
): Pick<PrismaClient, '$queryRaw'> => ({ $queryRaw: vi.fn().mockResolvedValue(rows) });
beforeEach(() => {
  vi.resetAllMocks();
  state.transaction.mockImplementation((write) => write({ private: true }));
  state.disconnect.mockResolvedValue(undefined);
});

it('uses a private tuned writer on the actual file with finite budgets', async () => {
  const write = vi.fn().mockResolvedValue('committed');
  await expect(withBackupImport(source(), write)).resolves.toBe('committed');
  expect(state.adapter).toHaveBeenCalledWith({
    url: '/actual.db',
    fileMustExist: true,
    timeout: 5000,
  });
  expect(state.transaction).toHaveBeenCalledWith(write, { timeout: 120_000 });
  expect(write).toHaveBeenCalledWith({ private: true });
  expect(state.disconnect).toHaveBeenCalledOnce();
});

it.each([
  { rows: null, path: [], expected: 'array' },
  { rows: {}, path: [], expected: 'array' },
  { rows: [{ name: 'main', file: 4 }], path: [0, 'file'], expected: 'string' },
])(
  'rejects malformed source database rows with the original validation error: $rows',
  async ({ rows, path, expected }) => {
    const imported = withBackupImport(source(rows), vi.fn());
    await expect(imported).rejects.toBeInstanceOf(ZodError);
    await expect(imported).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'invalid_type', path, expected })],
    });
    expect(state.adapter).not.toHaveBeenCalled();
  }
);

it.each([
  { rows: [] },
  { rows: [{ name: 'main', file: '' }] },
  { rows: [{ name: 'main', file: ':memory:' }] },
  { rows: [{ name: 'main', file: 'relative.db' }] },
  {
    rows: [
      { name: 'main', file: '/a' },
      { name: 'main', file: '/b' },
    ],
  },
])('rejects invalid main paths before private construction: $rows', async ({ rows }) => {
  await expect(withBackupImport(source(rows), vi.fn())).rejects.toThrow(
    new Error('Backup requires exactly one file-backed main database')
  );
  expect(state.adapter).not.toHaveBeenCalled();
});

const conflicts = [
  { code: 'P2028' },
  { code: 'P1008' },
  { code: 'SQLITE_BUSY' },
  { code: 'SQLITE_BUSY_SNAPSHOT' },
  {
    meta: {
      driverAdapterError: { cause: { originalCode: 'SQLITE_BUSY_TIMEOUT', kind: 'SocketTimeout' } },
    },
  },
  { cause: { originalCode: 'UNKNOWN_SQLITE_ERROR_261' } },
];
it.each(conflicts)(
  'classifies structured whole-import failure %j and retains its cause',
  async (failure) => {
    state.transaction.mockRejectedValue(failure);
    await expect(withBackupImport(source(), vi.fn())).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('Retry the whole import'),
      cause: failure,
    });
    expect(state.disconnect).toHaveBeenCalledOnce();
  }
);
it('classifies discovery and adapter construction failures too', async () => {
  const failure = { code: 'SQLITE_BUSY' };
  const db = source();
  vi.mocked(db.$queryRaw).mockRejectedValue(failure);
  const discoveryFailure = withBackupImport(db, vi.fn());
  await expect(discoveryFailure).rejects.toBeInstanceOf(ApplicationError);
  await expect(discoveryFailure).rejects.toMatchObject({ code: 'CONFLICT', cause: failure });
  expect(state.adapter).not.toHaveBeenCalled();
  state.adapter.mockImplementation(() => {
    throw failure;
  });
  await expect(withBackupImport(source(), vi.fn())).rejects.toMatchObject({
    cause: failure,
    code: 'CONFLICT',
  });
});
it.each([
  new Error('busy timeout validation'),
  { code: 'P2003' },
  { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' },
  { kind: 'SocketTimeout' },
  { code: 'SQLITE_BUSYNESS' },
])('preserves unrelated failures %j', async (failure) => {
  state.transaction.mockRejectedValue(failure);
  await expect(withBackupImport(source(), vi.fn())).rejects.toBe(failure);
});
it('preserves the primary failure if disconnect also fails', async () => {
  const primary = new Error('validation failure');
  state.transaction.mockRejectedValue(primary);
  state.disconnect.mockRejectedValue({ code: 'SQLITE_BUSY' });
  await expect(withBackupImport(source(), vi.fn())).rejects.toBe(primary);
  expect(state.warn).toHaveBeenCalledOnce();
});
it('classifies the primary busy failure if disconnect also fails', async () => {
  const primary = { code: 'P2028' };
  state.transaction.mockRejectedValue(primary);
  state.disconnect.mockRejectedValue(new Error('cleanup'));
  await expect(withBackupImport(source(), vi.fn())).rejects.toMatchObject({
    code: 'CONFLICT',
    cause: primary,
  });
});
it('surfaces a cleanup-only busy failure unchanged after commit', async () => {
  const cleanup = { code: 'SQLITE_BUSY' };
  state.disconnect.mockRejectedValue(cleanup);
  await expect(withBackupImport(source(), async () => 'committed')).rejects.toBe(cleanup);
});
it('leaves export busy failures unchanged', async () => {
  const failure = { code: 'P1008' };
  state.transaction.mockRejectedValue(failure);
  await expect(withBackupSnapshot(source(), vi.fn())).rejects.toBe(failure);
});
