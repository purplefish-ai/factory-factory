import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { registerFatalErrorHandlers } from './fatal-error-handlers.js';

function createHandlerHarness() {
  const quit = vi.fn();
  const quitSignal = Promise.withResolvers<void>();
  const app = {
    quit() {
      quit();
      quitSignal.resolve();
    },
  };
  const dialog = {
    showErrorBox: vi.fn(),
  };
  const logger = {
    error: vi.fn(),
  };
  const process = new EventEmitter();
  const serverManager = { stop: vi.fn().mockResolvedValue(undefined) };

  registerFatalErrorHandlers({ app, dialog, logger, process, serverManager });

  return { quit, didQuit: quitSignal.promise, dialog, logger, process, serverManager };
}

describe('fatal Electron error handlers', () => {
  it.each(['uncaughtException', 'unhandledRejection'])(
    'waits for backend cleanup before quitting on %s',
    async (event) => {
      const { quit, didQuit, process, serverManager } = createHandlerHarness();
      let finishStop!: () => void;
      serverManager.stop.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishStop = resolve;
          })
      );
      process.emit(event, new Error('fatal'));
      expect(serverManager.stop).toHaveBeenCalledTimes(1);
      expect(quit).not.toHaveBeenCalled();
      finishStop();
      await didQuit;
      expect(quit).toHaveBeenCalledTimes(1);
    }
  );

  it('quits at the deadline when startup or cleanup never settles', async () => {
    vi.useFakeTimers();
    try {
      const { quit, logger, process, serverManager } = createHandlerHarness();
      let finishStop!: () => void;
      serverManager.stop.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishStop = resolve;
          })
      );
      process.emit('uncaughtException', new Error('fatal during startup'));
      await vi.advanceTimersByTimeAsync(29_999);
      expect(quit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(quit).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        '[electron] Failed to stop backend after fatal error:',
        expect.objectContaining({ message: 'Backend shutdown timed out after 30000ms' })
      );
      finishStop();
      await vi.advanceTimersByTimeAsync(0);
      expect(quit).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('quits even if backend cleanup fails', async () => {
    const { quit, didQuit, logger, process, serverManager } = createHandlerHarness();
    const error = new Error('cleanup failed');
    serverManager.stop.mockRejectedValue(error);
    process.emit('unhandledRejection', new Error('fatal'));
    await didQuit;
    expect(quit).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      '[electron] Failed to stop backend after fatal error:',
      error
    );
  });

  it('does not start another shutdown when a second fatal error arrives', async () => {
    const { quit, didQuit, process, serverManager } = createHandlerHarness();
    let finishStop!: () => void;
    serverManager.stop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        })
    );
    process.emit('uncaughtException', new Error('first'));
    process.emit('unhandledRejection', new Error('second'));
    expect(serverManager.stop).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    finishStop();
    await didQuit;
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('shows uncaught exceptions and quits after backend cleanup', async () => {
    const { quit, didQuit, dialog, logger, process } = createHandlerHarness();
    const error = new Error('fatal startup failure');

    process.emit('uncaughtException', error);

    expect(logger.error).toHaveBeenCalledWith('[electron] Uncaught exception:', error);
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'Uncaught Exception',
      expect.stringContaining('fatal startup failure')
    );
    await didQuit;
    expect(quit).toHaveBeenCalledTimes(1);
    expect(dialog.showErrorBox.mock.invocationCallOrder[0]).toBeLessThan(
      quit.mock.invocationCallOrder[0]
    );
  });

  it.each(['plain exception', null, undefined])('shows non-Error exception %s', async (error) => {
    const { quit, didQuit, dialog, process, serverManager } = createHandlerHarness();
    process.emit('uncaughtException', error);
    expect(dialog.showErrorBox).toHaveBeenCalledWith('Uncaught Exception', String(error));
    expect(serverManager.stop).toHaveBeenCalledTimes(1);
    await didQuit;
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it.each(['plain rejection', null, undefined])('shows non-Error rejection %s', async (reason) => {
    const { quit, didQuit, dialog, process } = createHandlerHarness();
    process.emit('unhandledRejection', reason);
    expect(dialog.showErrorBox).toHaveBeenCalledWith('Unhandled Rejection', String(reason));
    await didQuit;
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('falls back to the message when an Error has no stack', () => {
    const { dialog, process } = createHandlerHarness();
    const reason = new Error('no stack');
    reason.stack = undefined;
    process.emit('unhandledRejection', reason);
    expect(dialog.showErrorBox).toHaveBeenCalledWith('Unhandled Rejection', String(reason));
  });

  it('shows unhandled rejections and quits after backend cleanup', async () => {
    const { quit, didQuit, dialog, logger, process } = createHandlerHarness();
    const reason = new Error('async setup failed');

    process.emit('unhandledRejection', reason);

    expect(logger.error).toHaveBeenCalledWith('[electron] Unhandled rejection:', reason);
    expect(dialog.showErrorBox).toHaveBeenCalledWith('Unhandled Rejection', reason.stack);
    await didQuit;
    expect(quit).toHaveBeenCalledTimes(1);
    expect(dialog.showErrorBox.mock.invocationCallOrder[0]).toBeLessThan(
      quit.mock.invocationCallOrder[0]
    );
  });
});
