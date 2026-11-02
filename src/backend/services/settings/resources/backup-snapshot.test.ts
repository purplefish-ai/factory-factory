import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  constructed: vi.fn(),
  transaction: vi.fn(async (read: () => Promise<unknown>) => await read()),
  disconnect: vi.fn(async () => undefined),
}));
vi.mock('@prisma-gen/client', () => ({
  PrismaClient: class {
    constructor(options: unknown) {
      state.constructed(options);
    }
    $transaction = state.transaction;
    $disconnect = state.disconnect;
  },
}));
import { withBackupSnapshot } from './backup-snapshot';
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
