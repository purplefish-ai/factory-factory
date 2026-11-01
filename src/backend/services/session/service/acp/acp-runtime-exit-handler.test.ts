const logger = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/backend/services/logger.service', () => ({ createLogger: () => logger }));
import { expect, it, vi } from 'vitest';
import { dispatchExitAfterCleanup } from './acp-runtime-exit-handler';
it.each([true, false])(
  'runs owned cleanup only for unexpected exit, managed=%s',
  async (managed) => {
    const cleanup = vi.fn(async () => undefined);
    const onRuntimeExit = vi.fn(async () => undefined);
    await dispatchExitAfterCleanup(
      { onRuntimeExit },
      { sessionId: 'session', incarnationId: 'runtime', purpose: 'active', managed, exitCode: 0 },
      cleanup
    );
    expect(cleanup).toHaveBeenCalledTimes(managed ? 0 : 1);
    expect(onRuntimeExit).toHaveBeenCalledOnce();
  }
);
it.each(['resolve', 'reject'] as const)(
  'awaits cleanup %s before exit observation starts',
  async (result) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const cleanup = () =>
      new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
    const onRuntimeExit = vi.fn(async () => undefined);
    logger.warn.mockClear();
    const pending = dispatchExitAfterCleanup(
      { onRuntimeExit },
      { sessionId: 's', incarnationId: 'r', purpose: 'active', managed: false, exitCode: 1 },
      cleanup
    );
    await Promise.resolve();
    expect(onRuntimeExit).not.toHaveBeenCalled();
    if (result === 'resolve') {
      resolve();
    } else {
      reject(new Error('untrusted secret'));
    }
    await pending;
    expect(onRuntimeExit).toHaveBeenCalledOnce();
    if (result === 'reject') {
      expect(logger.warn).toHaveBeenCalledWith('Event exit runtime cleanup is unconfirmed', {
        sessionId: 's',
      });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
    } else {
      expect(logger.warn).not.toHaveBeenCalled();
    }
  }
);
