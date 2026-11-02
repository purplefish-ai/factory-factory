import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerFatalErrorHandlers } from './fatal-error-handlers';

type FatalEvent = 'uncaughtException' | 'unhandledRejection';
type FatalHandler = (value: unknown) => Promise<void>;

function createHandlerHarness() {
  const logger = {
    error: vi.fn(),
    fatal: vi.fn(),
  };
  const server = {
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const process = Object.assign(new EventEmitter(), {
    exit: vi.fn(),
  });

  registerFatalErrorHandlers({ logger, process, server });

  const getHandler = (event: FatalEvent): FatalHandler => {
    const [handler] = process.rawListeners(event);
    expect(handler).toBeDefined();
    return handler as FatalHandler;
  };

  return { getHandler, logger, process, server };
}

describe('backend fatal error handlers', () => {
  afterEach(() => vi.useRealTimers());
  it('logs an Error rejection, waits for cleanup, and exits with failure', async () => {
    const { getHandler, logger, process, server } = createHandlerHarness();
    let finishCleanup: (() => void) | undefined;
    server.stop.mockReturnValue(
      new Promise<void>((resolve) => {
        finishCleanup = resolve;
      })
    );
    const error = new Error('async failure');

    const handling = getHandler('unhandledRejection')(error);

    expect(logger.fatal).toHaveBeenCalledWith('Unhandled rejection at promise', {
      message: error.message,
      stack: error.stack,
      name: error.name,
    });
    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(process.exit).not.toHaveBeenCalled();

    finishCleanup?.();
    await handling;

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('logs a non-Error rejection reason before shutting down', async () => {
    const { getHandler, logger, process } = createHandlerHarness();

    await getHandler('unhandledRejection')('connection lost');

    expect(logger.fatal).toHaveBeenCalledWith('Unhandled rejection at promise', {
      reason: 'connection lost',
    });
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('shuts down when a non-Error rejection reason cannot be stringified', async () => {
    const { getHandler, logger, process, server } = createHandlerHarness();
    const reason = {
      [Symbol.toPrimitive]() {
        throw new Error('coercion failed');
      },
    };

    await getHandler('unhandledRejection')(reason);

    expect(logger.fatal).toHaveBeenCalledWith('Unhandled rejection at promise', {
      reason: '[unstringifiable rejection reason]',
    });
    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('exits when server cleanup fails', async () => {
    const { getHandler, process, server } = createHandlerHarness();
    server.stop.mockRejectedValue(new Error('cleanup failed'));

    await getHandler('unhandledRejection')(new Error('async failure'));

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('runs cleanup and exits only once for concurrent fatal events', async () => {
    const { getHandler, logger, process, server } = createHandlerHarness();
    let finishCleanup: (() => void) | undefined;
    server.stop.mockReturnValue(
      new Promise<void>((resolve) => {
        finishCleanup = resolve;
      })
    );

    const firstHandling = getHandler('unhandledRejection')(new Error('first failure'));
    for (let index = 0; index < 1000; index++) {
      await getHandler('uncaughtException')(new Error('write EPIPE'));
    }
    expect(logger.fatal).toHaveBeenCalledTimes(1);

    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(process.exit).not.toHaveBeenCalled();

    finishCleanup?.();
    await firstHandling;

    expect(process.exit).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('claims shutdown before a reentrant logging failure', async () => {
    const { getHandler, logger, process, server } = createHandlerHarness();
    logger.fatal.mockImplementationOnce(() => {
      void getHandler('uncaughtException')(new Error('write EPIPE'));
    });

    await getHandler('uncaughtException')(new Error('first failure'));

    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledTimes(1);
  });

  it('still cleans up and exits if the fatal log sink throws', async () => {
    const { getHandler, logger, process, server } = createHandlerHarness();
    logger.fatal.mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });

    await getHandler('uncaughtException')(new Error('first failure'));

    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('exits within 30 seconds when cleanup never settles', async () => {
    vi.useFakeTimers();
    const { getHandler, process, server } = createHandlerHarness();
    server.stop.mockReturnValue(
      new Promise(() => {
        // Simulate cleanup that never settles.
      })
    );

    const handling = getHandler('uncaughtException')(new Error('first failure'));
    await vi.advanceTimersByTimeAsync(30_000);
    await handling;

    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('supports injected loggers that only expose error()', async () => {
    const logger = { error: vi.fn() };
    const server = { stop: vi.fn().mockResolvedValue(undefined) };
    const process = Object.assign(new EventEmitter(), { exit: vi.fn() });
    registerFatalErrorHandlers({ logger, process, server });
    process.emit('uncaughtException', new Error('original failure'));
    process.emit('uncaughtException', new Error('write EPIPE'));
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('preserves uncaught exception logging and fatal shutdown', async () => {
    const { getHandler, logger, process, server } = createHandlerHarness();
    const error = new Error('synchronous failure');

    await getHandler('uncaughtException')(error);

    expect(logger.fatal).toHaveBeenCalledWith('Uncaught exception', error);
    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
