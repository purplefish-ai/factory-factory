import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runExclusiveWorkspaceOperation } from './fixer-workflow.service';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('runExclusiveWorkspaceOperation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deduplicates concurrent operations for the same workspace', async () => {
    const pendingMap = new Map<string, Promise<string>>();
    let resolveOperation!: (value: string) => void;
    const operation = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveOperation = resolve;
        })
    );

    const first = runExclusiveWorkspaceOperation({
      pendingMap,
      workspaceId: 'w1',
      logger,
      duplicateOperationMessage: 'duplicate',
      operation,
    });

    const second = runExclusiveWorkspaceOperation({
      pendingMap,
      workspaceId: 'w1',
      logger,
      duplicateOperationMessage: 'duplicate',
      operation,
    });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith('duplicate', { workspaceId: 'w1' });

    resolveOperation('done');

    await expect(first).resolves.toBe('done');
    await expect(second).resolves.toBe('done');
    expect(pendingMap.size).toBe(0);
  });

  it('converts synchronous throws to rejected promises and clears pending map', async () => {
    const pendingMap = new Map<string, Promise<string>>();

    const result = runExclusiveWorkspaceOperation({
      pendingMap,
      workspaceId: 'w1',
      logger,
      duplicateOperationMessage: 'duplicate',
      operation: () => {
        throw new Error('sync failure');
      },
    });

    await expect(result).rejects.toThrow('sync failure');
    expect(pendingMap.size).toBe(0);
  });
});
