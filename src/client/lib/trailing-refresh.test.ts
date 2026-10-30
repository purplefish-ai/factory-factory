import { describe, expect, it, vi } from 'vitest';
import { createTrailingRefresh } from './trailing-refresh';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('createTrailingRefresh', () => {
  it('runs one follow-up for triggers that arrive during a refresh', async () => {
    const runs = [deferred(), deferred()];
    const refresh = vi.fn(() => runs[refresh.mock.calls.length - 1]?.promise);
    const { trigger } = createTrailingRefresh(refresh);

    trigger();
    await settle();
    trigger();
    trigger();
    trigger();
    expect(refresh).toHaveBeenCalledOnce();

    runs[0]?.resolve();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);

    runs[1]?.resolve();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('runs again after a failed refresh when a trigger arrived meanwhile', async () => {
    const first = deferred();
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const { trigger } = createTrailingRefresh(refresh);

    trigger();
    await settle();
    trigger();
    first.reject(new Error('network'));
    await settle();

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('starts the first refresh synchronously and survives a synchronous throw', async () => {
    const refresh = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('boom');
      })
      .mockResolvedValue(undefined);
    const { trigger } = createTrailingRefresh(refresh);

    trigger();
    expect(refresh).toHaveBeenCalledOnce();
    await settle();
    trigger();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('drops a queued follow-up and ignores triggers after dispose', async () => {
    const first = deferred();
    const refresh = vi.fn(() => first.promise);
    const { trigger, dispose } = createTrailingRefresh(refresh);

    trigger();
    await settle();
    trigger();
    dispose();
    first.resolve();
    await settle();
    trigger();

    expect(refresh).toHaveBeenCalledOnce();
  });

  it('starts a fresh refresh once idle', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { trigger } = createTrailingRefresh(refresh);

    trigger();
    await settle();
    trigger();
    await settle();

    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
