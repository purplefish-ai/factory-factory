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
