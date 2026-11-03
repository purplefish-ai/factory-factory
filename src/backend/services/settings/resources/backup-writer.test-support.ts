import { expect, vi } from 'vitest';
import { dataBackupAccessor } from './data-backup.accessor';

/** Observe the owning capsule's boundary without exposing its raw writer to callers. */
export async function expectBackupWriterUnopened(action: () => Promise<void>): Promise<void> {
  const writer = vi.spyOn(dataBackupAccessor, 'runInTransaction');
  try {
    await action();
    expect(writer).not.toHaveBeenCalled();
  } finally {
    writer.mockRestore();
  }
}
