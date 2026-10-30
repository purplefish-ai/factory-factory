import { describe, expect, it, vi } from 'vitest';
import { KeyedTrailingRunner } from './keyed-trailing-runner';

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

describe('KeyedTrailingRunner', () => {
  it('starts immediately and collapses requests during a run into one rerun', async () => {
    const runner = new KeyedTrailingRunner();
    const first = deferred();
    const firstTask = vi.fn(() => first.promise);
    const secondTask = vi.fn().mockResolvedValue(undefined);
    const latestTask = vi.fn().mockResolvedValue(undefined);

    runner.run('a', firstTask);
    expect(firstTask).toHaveBeenCalledOnce();

    runner.run('a', secondTask);
    runner.run('a', latestTask);
    first.resolve();
    await settle();

    expect(secondTask).not.toHaveBeenCalled();
    expect(latestTask).toHaveBeenCalledOnce();
  });

  it('runs different keys independently', () => {
    const runner = new KeyedTrailingRunner();
    const a = vi.fn(() => new Promise<void>(() => undefined));
    const b = vi.fn().mockResolvedValue(undefined);

    runner.run('a', a);
    runner.run('b', b);

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('keeps going after a failed run', async () => {
    const runner = new KeyedTrailingRunner();
    const first = deferred();
    const rerun = vi.fn().mockResolvedValue(undefined);

    runner.run('a', () => first.promise);
    runner.run('a', rerun);
    first.reject(new Error('boom'));
    await settle();
    expect(rerun).toHaveBeenCalledOnce();

    const later = vi.fn().mockResolvedValue(undefined);
    runner.run('a', later);
    expect(later).toHaveBeenCalledOnce();
  });

  it('drops queued reruns on clear and accepts new work afterwards', async () => {
    const runner = new KeyedTrailingRunner();
    const first = deferred();
    const rerun = vi.fn().mockResolvedValue(undefined);

    runner.run('a', () => first.promise);
    runner.run('a', rerun);
    runner.clear();
    const fresh = vi.fn().mockResolvedValue(undefined);
    runner.run('a', fresh);
    first.resolve();
    await settle();

    expect(rerun).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledOnce();
  });
});
