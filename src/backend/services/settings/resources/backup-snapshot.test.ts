import { beforeEach, expect, it, vi } from 'vitest';
import { ApplicationError } from '@/backend/lib/application-error';
import { Prisma } from '@prisma-gen/client';
const state = vi.hoisted(() => ({
  constructed: vi.fn(),
  logError: vi.fn(),
  transaction: vi.fn(async (read: () => Promise<unknown>) => await read()),
  disconnect: vi.fn(async () => undefined),
}));
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
it('closes its private reader when snapshot decoding fails', async () => {
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
it('preserves snapshot query failures instead of classifying them as import conflicts', async () => {
  const source = { $queryRaw: vi.fn().mockResolvedValue([{ name: 'main', file: '/main.db' }]) };
  const busy = new Prisma.PrismaClientKnownRequestError('SQLite busy', {
    code: 'P1008',
    clientVersion: 'test',
  });
  await expect(withBackupSnapshot(source, () => Promise.reject(busy))).rejects.toBe(busy);
  expect(state.disconnect).toHaveBeenCalledOnce();
});
